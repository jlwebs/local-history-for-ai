import * as vscode from 'vscode';

import fs = require('fs');
import path = require('path');
import crypto = require('crypto');
import Timeout from './timeout';

import glob = require('glob');
import rimraf = require('rimraf');
// import mkdirp = require('mkdirp');
import anymatch = require('anymatch');

// node 8.5 has natively fs.copyFile
// import copyFile = require('fs-copy-file');

import {IHistorySettings, HistorySettings} from './history.settings';
import { logInfo, logWarn } from './logger';

interface IHistoryActionValues {
    active: string;
    selected: string;
    previous: string;
}

export interface IPacketInfo {
    id: string;
    startedAt: string;
    lastActivityAt: string;
    snapshotCount: number;
    files: {[relativeFile: string]: number};
}

export interface IPacketSnapshotInfo {
    packetId: string;
    sourceFile: string;
    savedAt: string;
}

interface IPacketStoreData {
    version: number;
    currentPacketId?: string;
    lastActivityAt?: string;
    packets: {[packetId: string]: IPacketInfo};
    snapshots: {[relativeSnapshotPath: string]: IPacketSnapshotInfo};
}

export interface IHistoryFileProperties {
    dir: string;
    name: string;
    ext: string;
    file?: string;
    date?: Date;
    history?: string[];
}

/**
 * Controller for handling history.
 */
export class HistoryController {

    private settings: HistorySettings;
    private saveBatch;
    private fileWatchBatch: Map<string, NodeJS.Timeout>;

    private pattern = '_*';
    private regExp = /_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/;

    constructor() {
        this.settings = new HistorySettings();
        this.saveBatch = new Map();
        this.fileWatchBatch = new Map();
    }

    public saveFirstRevision(document: vscode.TextDocument) {
        // Put a timeout of 1000 ms, cause vscode wait until a delay and then continue the saving.
        // Timeout avoid to save a wrong version, because it's to late and vscode has already saved the file.
        // (if an error occured 3 times this code will not be called anymore.)
        // cf. https://github.com/Microsoft/vscode/blob/master/src/vs/workbench/api/node/extHostDocumentSaveParticipant.ts
        return this.internalSave(document, true, new Timeout(1000));
    }

    public saveRevision(document: vscode.TextDocument): Promise<vscode.TextDocument> {
        return this.internalSave(document);
    }

    public saveFileRevision(file: vscode.Uri, reason?: string): Promise<boolean> {
        const fileName = file && file.fsPath;
        if (!fileName) {
            return Promise.resolve(false);
        }

        const settings = this.getSettings(file);
        if (!this.allowSavePath(settings, fileName)) {
            logWarn(`Skipping file system snapshot for ${fileName}`);
            return Promise.resolve(false);
        }

        logInfo(`Queue snapshot for ${fileName} (${reason || 'unknown'})`);
        return this.scheduleFileSnapshot(fileName, settings, reason);
    }

    public handleDeletion(file: vscode.Uri): Promise<boolean> {
        const fileName = file && file.fsPath;
        if (!fileName) {
            return Promise.resolve(false);
        }

        const timer = this.fileWatchBatch.get(fileName);
        if (timer) {
            clearTimeout(timer);
            this.fileWatchBatch.delete(fileName);
        }

        const settings = this.getSettings(file);
        if (!this.allowSavePath(settings, fileName)) {
            return Promise.resolve(false);
        }

        return Promise.resolve(false);
    }

    public showAll(editor: vscode.TextEditor) {
        this.internalShowAll(this.actionOpen, editor, this.getSettings(editor.document.uri));
    }
    public showCurrent(editor: vscode.TextEditor) {
        let document = (editor && editor.document);

        if (document)
            return this.internalOpen(this.findCurrent(document.fileName, this.getSettings(editor.document.uri)), editor.viewColumn);
    }

    public compareToActive(editor: vscode.TextEditor) {
        this.internalShowAll(this.actionCompareToActive, editor, this.getSettings(editor.document.uri));
    }

    public compareToCurrent(editor: vscode.TextEditor) {
        this.internalShowAll(this.actionCompareToCurrent, editor, this.getSettings(editor.document.uri));
    }

    public compareToPrevious(editor: vscode.TextEditor) {
        this.internalShowAll(this.actionCompareToPrevious, editor, this.getSettings(editor.document.uri));
    }

    public compare(file1: vscode.Uri, file2: vscode.Uri, column?: string, range?: vscode.Range) {
        return this.internalCompare(file1, file2, column, range);
    }

    public findAllHistory(fileName: string, settings: IHistorySettings, noLimit?: boolean): Promise<IHistoryFileProperties> {
        return new Promise((resolve, reject) => {

            if (!settings.enabled)
                resolve();

            let fileProperties = this.decodeFile(fileName, settings, true);
            this.getHistoryFiles(fileProperties && fileProperties.file, settings, noLimit)
                .then(files => {
                    fileProperties.history = files;
                    resolve(fileProperties);
                })
                .catch(err => reject(err));
        });
    }

    public findGlobalHistory(find: string, findFile: boolean, settings: IHistorySettings, noLimit?: boolean): Promise<string[]> {
        return new Promise((resolve, reject) => {

            if (!settings.enabled)
                resolve();

            if (findFile)
                this.findAllHistory(find, settings, noLimit)
                    .then(fileProperties => resolve(fileProperties && fileProperties.history));
            else
                this.getHistoryFiles(find, settings, noLimit)
                    .then(files => {
                        resolve(files);
                    })
                    .catch(err => reject(err));
            });
    }

    public decodeFile(filePath: string, settings: IHistorySettings, history?: boolean): IHistoryFileProperties {
        return this.internalDecodeFile(filePath, settings, history);
    }

    public getSettings(file: vscode.Uri): IHistorySettings {
        return this.settings.get(file);
    }

    public clearSettings() {
        this.settings.clear();
    }

    public getPacketInfo(fileName: string, settings: IHistorySettings): IPacketSnapshotInfo {
        const store = this.readPacketStore(settings);
        return store.snapshots[this.getRelativeHistoryPath(fileName, settings)];
    }

    public getPacketStore(file: vscode.Uri): {[packetId: string]: IPacketInfo} {
        const settings = this.getSettings(file);
        return this.readPacketStore(settings).packets;
    }

    public deleteFile(fileName: string): Promise<void> {
        return this.deleteFiles([fileName]);
    }

    public deleteFiles(fileNames: string[]): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            this.internalDeleteHistory(fileNames)
                .then(() => resolve())
                .catch((err) => reject());
        });
    }

    public deleteAll(fileHistoryPath: string) {
        return new Promise((resolve, reject) => {
            rimraf(fileHistoryPath, err => {
                if (err)
                    return reject(err);
                return resolve();
            });
        });
    }

    public purgeExpiredHistory(file: vscode.Uri): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const settings = this.getSettings(file);
            if (!settings.enabled || !settings.historyPath || settings.daysLimit <= 0) {
                return resolve();
            }

            glob('**/*', {cwd: settings.historyPath.replace(/\\/g, '/'), absolute: true}, (err, files: string[]) => {
                if (err) {
                    return reject(err);
                }

                files.forEach(historyFile => {
                    try {
                        const stat = fs.statSync(historyFile);
                        if (!stat.isFile()) {
                            return;
                        }

                        const endTime = stat.birthtime.getTime() + settings.daysLimit * 24 * 60 * 60 * 1000;
                        if (Date.now() > endTime) {
                            fs.unlinkSync(historyFile);
                            this.cleanupPacketMetadata([historyFile]);
                        }
                    } catch (e) {
                        // Continue purging other files.
                    }
                });

                resolve();
            });
        });
    }

    public deleteHistory(fileName: string): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const settings = this.getSettings(vscode.Uri.file(fileName));
            const fileProperties = this.decodeFile(fileName, settings, true);
            this.getHistoryFiles(fileProperties && fileProperties.file, settings, true)
                .then((files) => this.internalDeleteHistory(files))
                .then(() => resolve())
                .catch((err) => reject());
        });
    }

    public restore(fileName: vscode.Uri) {
        const src = fileName.fsPath;
        const settings = this.getSettings(vscode.Uri.file(src));
        const fileProperties = this.decodeFile(src, settings, false);
        if (fileProperties && fileProperties.file) {
            return new Promise((resolve, reject) => {
                // Node v.8.5 has fs.copyFile
                // const fnCopy = fs.copyFile || copyFile;

                fs.copyFile(src, fileProperties.file, err => {
                    if (err)
                        return reject(err);
                    return resolve();
                });
            });
        }
    }

    /* private */
    private internalSave(document: vscode.TextDocument, isOriginal?: boolean, timeout?: Timeout): Promise<vscode.TextDocument> {

        const settings = this.getSettings(document.uri);

        if (!this.allowSave(settings, document)) {
            return Promise.resolve(undefined);
        }

        if (!isOriginal && settings.saveDelay) {
            if (!this.saveBatch.get(document.fileName)) {
                this.saveBatch.set(document.fileName, document);
                return this.timeoutPromise(this.internalSaveDocument, settings.saveDelay * 1000, [document, settings]);
            } else return Promise.reject(undefined); // waiting
        }

        return this.internalSaveDocument(document, settings, isOriginal, timeout);
    }

    private timeoutPromise(f, delay, args): Promise<any> {
        return new Promise((resolve, reject) => {
            setTimeout(() => {
                f.apply(this, args)
                    .then(value => resolve(value))
                    .catch(value => reject(value));
            }, delay);
        });
    }

    private internalSaveDocument(document: vscode.TextDocument, settings: IHistorySettings, isOriginal?: boolean, timeout?: Timeout): Promise<vscode.TextDocument> {

        return new Promise((resolve, reject) => {
            const revisionPattern = this.getRevisionPattern(document.fileName, settings);

            if (isOriginal) {
                // if already some files exists, don't save an original version (cause: the really original version is lost) !
                // (Often the case...)
                const files = glob.sync(revisionPattern, {cwd: settings.historyPath.replace(/\\/g, '/')});
                if (files && files.length > 0)
                    return resolve();

                if (timeout && timeout.isTimedOut()) {
                    vscode.window.showErrorMessage(`Timeout when internalSave: ' ${document.fileName}`);
                    return reject('timedout');
                }
            }
            else if (settings.saveDelay)
                this.saveBatch.delete(document.fileName);

            const latest = this.findLatestHistoryFile(document.fileName, settings);
            const latestHash = latest && fs.existsSync(latest) ? this.computeFileHash(latest) : null;
            const currentHash = this.computeFileHash(document.fileName);
            if (!isOriginal && latestHash && currentHash && latestHash === currentHash) {
                return resolve(undefined);
            }

            const revisionFile = this.copyFileRevision(document.fileName, settings, isOriginal, timeout);
            if (revisionFile) {
                this.registerSnapshotPacket(settings, document.fileName, revisionFile, new Date());
                if (settings.daysLimit > 0 && !isOriginal)
                    this.purge(document, settings, revisionPattern);
                return resolve(document);
            } else
                return reject('Error occured');
        });
    }

    private allowSave(settings: IHistorySettings, document: vscode.TextDocument): boolean {
        if (!settings.enabled) {
            return false;
        }

        if (!(document && /*document.isDirty &&*/ document.fileName)) {
            return false;
        }

        // Use '/' with glob
        const docFile = document.fileName.replace(/\\/g, '/');
        // @ts-ignore
        if (settings.exclude && settings.exclude.length > 0 && anymatch(settings.exclude, docFile))
            return false;

        return true;
    }

    private allowSavePath(settings: IHistorySettings, fileName: string): boolean {
        if (!settings.enabled || !fileName) {
            return false;
        }

        if (!fs.existsSync(fileName)) {
            return false;
        }

        const stat = fs.statSync(fileName);
        if (!stat.isFile()) {
            return false;
        }

        const docFile = fileName.replace(/\\/g, '/');
        // @ts-ignore
        if (settings.exclude && settings.exclude.length > 0 && anymatch(settings.exclude, docFile))
            return false;

        const historyPath = settings.historyPath && settings.historyPath.replace(/\\/g, '/');
        if (historyPath && docFile.indexOf(historyPath) === 0) {
            return false;
        }

        return true;
    }

    private scheduleFileSnapshot(fileName: string, settings: IHistorySettings, reason?: string): Promise<boolean> {
        const delay = Math.max(settings.saveDelay * 1000, 250);

        return new Promise(resolve => {
            const currentTimer = this.fileWatchBatch.get(fileName);
            if (currentTimer) {
                clearTimeout(currentTimer);
            }

            const timer = setTimeout(() => {
                this.fileWatchBatch.delete(fileName);
                this.saveFileSnapshot(fileName, settings, reason)
                    .then(resolve)
                    .catch(() => resolve(false));
            }, delay);

            this.fileWatchBatch.set(fileName, timer);
        });
    }

    private saveFileSnapshot(fileName: string, settings: IHistorySettings, reason?: string): Promise<boolean> {
        return new Promise((resolve) => {
            if (!this.allowSavePath(settings, fileName)) {
                logWarn(`Skipping save for ${fileName}: filtered or unsupported.`);
                return resolve(false);
            }

            const latest = this.findLatestHistoryFile(fileName, settings);
            const latestHash = latest && fs.existsSync(latest) ? this.computeFileHash(latest) : null;
            const currentHash = this.computeFileHash(fileName);

            if (!currentHash) {
                logWarn(`Unable to hash current file ${fileName}`);
                return resolve(false);
            }

            if (latestHash && latestHash === currentHash) {
                logInfo(`No snapshot written for ${fileName}: content unchanged.`);
                return resolve(false);
            }

            const saved = this.copyFileRevision(fileName, settings, false);
            if (saved) {
                this.registerSnapshotPacket(settings, fileName, saved, new Date());
            }
            if (saved && settings.daysLimit > 0) {
                const revisionPattern = this.getRevisionPattern(fileName, settings);
                this.purgeFile(settings, revisionPattern);
            }

            if (saved) {
                logInfo(`Snapshot written for ${fileName}`);
            }
            resolve(Boolean(saved));
        });
    }

    private getHistoryFiles(patternFilePath: string, settings: IHistorySettings, noLimit?: boolean):  Promise<string[]> {

        return new Promise((resolve, reject) => {

            if (!patternFilePath)
                reject('no pattern path');

            // glob must use character /
            const historyPath = settings.historyPath.replace(/\\/g, '/');
            glob(patternFilePath, {cwd: historyPath, absolute: true}, (err, files: string[]) => {
                if (!err) {
                    if (files && files.length) {
                        // files are sorted in ascending order
                        // limitation
                        if (settings.maxDisplay && !noLimit)
                            files = files.slice(settings.maxDisplay * -1);
                        // files are absolute
                    }
                    resolve(files);
                } else
                    reject(err);
            });
        });
    }

    private internalShowAll(action, editor: vscode.TextEditor, settings: IHistorySettings) {

        if (!settings.enabled)
            return;

        let me = this,
            document = (editor && editor.document);

        if (!document)
            return;

        me.findAllHistory(document.fileName, settings)
            .then(fileProperties => {
                const files = fileProperties.history;

                if (!files || !files.length) {
                    return;
                }

                let displayFiles = [];
                let file, relative, properties;

                // desc order history
                for (let index = files.length - 1; index >= 0; index--) {
                    file = files[index];
                    relative = path.relative(settings.historyPath, file);
                    properties = me.decodeFile(file, settings);
                    displayFiles.push({
                        description: relative,
                        label: properties.date.toLocaleString(settings.dateLocale),
                        filePath: file,
                        previous: files[index - 1]
                    });
                }

                vscode.window.showQuickPick(displayFiles)
                    .then(val=> {
                        if (val) {
                            let actionValues: IHistoryActionValues = {
                                active: document.fileName,
                                selected: val.filePath,
                                previous: val.previous
                            };
                            action.apply(me, [actionValues, editor]);
                        }
                    });
            });
    }

    private actionOpen(values: IHistoryActionValues, editor: vscode.TextEditor) {
        return this.internalOpen(vscode.Uri.file(values.selected), editor.viewColumn);
    }

    private actionCompareToActive(values: IHistoryActionValues, editor: vscode.TextEditor) {
        return this.internalCompare(vscode.Uri.file(values.selected), vscode.Uri.file(values.active));
    }

    private actionCompareToCurrent(values: IHistoryActionValues, editor: vscode.TextEditor, settings: IHistorySettings) {
        return this.internalCompare(vscode.Uri.file(values.selected), this.findCurrent(values.active, settings));
    }

    private actionCompareToPrevious(values: IHistoryActionValues, editor: vscode.TextEditor) {
        if (values.previous)
            return this.internalCompare(vscode.Uri.file(values.selected), vscode.Uri.file(values.previous));
    }

    private internalOpen(filePath: vscode.Uri, column: number) {
        if (filePath)
            return new Promise((resolve, reject) => {
                vscode.workspace.openTextDocument(filePath)
                    .then(d=> {
                        vscode.window.showTextDocument(d, column)
                            .then(()=>resolve(), (err)=>reject(err));
                    }, (err)=>reject(err));
            });
    }

    private internalCompare(file1: vscode.Uri, file2: vscode.Uri, column?: string, range?: vscode.Range) {
        if (file1 && file2) {
            const option: any = {};
            if (column)
                option.viewColumn = Number.parseInt(column, 10);
            option.selection = range;
            // Diff on the active column
            let title = path.basename(file1.fsPath)+'<->'+path.basename(file2.fsPath);
            vscode.commands.executeCommand('vscode.diff', file1, file2, title, option);
        }
    }

    private internalDecodeFile(filePath: string, settings: IHistorySettings, history?: boolean): IHistoryFileProperties {
        let me = this,
            file, p,
            date,
            isHistory = false;

        p = path.parse(filePath);

        if (filePath.includes('/.history/') || filePath.includes('\\.history\\') ) { //startsWith(this.settings.historyPath))
            isHistory = true;
            let index = p.name.match(me.regExp);
            if (index) {
                date = new Date(index[1],index[2]-1,index[3],index[4],index[5],index[6]);
                p.name = p.name.substring(0, index.index);
            } else
                return null; // file in history with bad pattern !
        }

        if (history != null) {
            let root = '';

            if (history !== isHistory) {
                if (history === true) {
                    root = settings.historyPath;
                    if (!settings.absolute)
                        p.dir = path.relative(settings.folder.fsPath, p.dir);
                    else
                        p.dir = this.normalizePath(p.dir, false);
                } else { // if (history === false)
                    p.dir = path.relative(settings.historyPath, p.dir);
                    if (!settings.absolute) {
                        root = settings.folder.fsPath;
                    } else {
                        root = '';
                        p.dir = this.normalizePath(p.dir, true);
                    }
                }
            }
            file = me.joinPath(root, p.dir, p.name, p.ext, history ? undefined : '' );
        }
        else
            file = filePath;

        return {
            dir: p.dir,
            name: p.name,
            ext: p.ext,
            file: file,
            date: date
        };
    }

    private joinPath(root: string, dir: string, name: string, ext: string, pattern: string = this.pattern): string {
        return path.join(root, dir, name + pattern + ext);
    }

    private getRevisionPattern(fileName: string, settings: IHistorySettings): string {
        let revisionDir;
        if (!settings.absolute) {
            revisionDir = path.dirname(this.getRelativePath(fileName).replace(/\//g, path.sep));
        } else {
            revisionDir = this.normalizePath(path.dirname(fileName), false);
        }

        const p = path.parse(fileName);
        return this.joinPath(settings.historyPath, revisionDir, p.name, p.ext);
    }

    private getRevisionFile(fileName: string, settings: IHistorySettings, isOriginal?: boolean): string {
        let now = new Date(),
            nowInfo;

        if (isOriginal) {
            const state = fs.statSync(fileName);
            if (state)
                now = state.mtime;
        }

        now = new Date(now.getTime() - (now.getTimezoneOffset() * 60000) - (isOriginal ? 1000 : 0));
        nowInfo = now.toISOString().substring(0, 19).replace(/[-:T]/g, '');

        let revisionDir;
        if (!settings.absolute) {
            revisionDir = path.dirname(this.getRelativePath(fileName).replace(/\//g, path.sep));
        } else {
            revisionDir = this.normalizePath(path.dirname(fileName), false);
        }

        const parsed = path.parse(fileName);
        return this.joinPath(settings.historyPath, revisionDir, parsed.name, parsed.ext, `_${nowInfo}`);
    }

    private copyFileRevision(fileName: string, settings: IHistorySettings, isOriginal?: boolean, timeout?: Timeout): string {
        const revisionFile = this.getRevisionFile(fileName, settings, isOriginal);
        return this.mkDirRecursive(revisionFile) && this.copyFile(fileName, revisionFile, timeout)
            ? revisionFile
            : undefined;
    }

    private findLatestHistoryFile(fileName: string, settings: IHistorySettings): string {
        const revisionPattern = this.getRevisionPattern(fileName, settings);
        const files = glob.sync(revisionPattern, {cwd: settings.historyPath.replace(/\\/g, '/'), absolute: true});
        if (!files || !files.length) {
            return null;
        }

        return files[files.length - 1];
    }

    private computeFileHash(fileName: string): string {
        try {
            const data = fs.readFileSync(fileName);
            return crypto.createHash('sha1').update(data).digest('hex');
        } catch (err) {
            return null;
        }
    }

    private purgeFile(settings: IHistorySettings, pattern: string) {
        this.getHistoryFiles(pattern, settings, true)
            .then(files => {
                if (!files || !files.length) {
                    return;
                }

                let stat: fs.Stats,
                    now: number = new Date().getTime(),
                    endTime: number;

                for (let file of files) {
                    stat = fs.statSync(file);
                    if (stat && stat.isFile()) {
                        endTime = stat.birthtime.getTime() + settings.daysLimit * 24 * 60 * 60 * 1000;
                        if (now > endTime) {
                            fs.unlinkSync(file);
                        }
                    }
                }
            });
    }

    private findCurrent(activeFilename: string, settings: IHistorySettings): vscode.Uri {
        if (!settings.enabled)
          return vscode.Uri.file(activeFilename);

        let fileProperties = this.decodeFile(activeFilename, settings, false);
        if (fileProperties !== null)
            return vscode.Uri.file(fileProperties.file);
        else
            return vscode.Uri.file(activeFilename);
    }

    private internalDeleteFile(fileName: string): Promise<any> {
        return new Promise((resolve, reject) => {
            fs.unlink(fileName, err => {
                if (err)
                    // Not reject to avoid Promise.All to stop
                    return resolve({fileName: fileName, err: err});
                return resolve(fileName);
            });
        });
    }

    private internalDeleteHistory(fileNames: string[]): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            Promise.all(fileNames.map(file => this.internalDeleteFile(file)))
                .then(results => {
                    this.cleanupPacketMetadata(fileNames);
                    // Display 1st error
                    results.some((item: any) => {
                        if (item.err) {
                            vscode.window.showErrorMessage(`Error when delete files history: '${item.err}' file '${item.fileName}`);
                            return true;
                        }
                    });
                    resolve();
                })
                .catch(() => reject());
        });
    }

    private purge(document: vscode.TextDocument, settings: IHistorySettings, pattern: string) {
        this.purgeFile(settings, pattern);
    }

    private getRelativePath(fileName: string) {
        let relative = vscode.workspace.asRelativePath(fileName, false);

        if (fileName !== relative) {
            return relative;
        } else
            return path.basename(fileName);
    }

    private mkDirRecursive(fileName: string): boolean {
        try {
            fs.mkdirSync(path.dirname(fileName), {recursive: true});
            // mkdirp.sync(path.dirname(fileName));
            return true;
        }
        catch (err) {
            vscode.window.showErrorMessage(`Error with mkdir: '${err.toString()}' file '${fileName}`);
            return false;
        }
    }

    private copyFile(source: string, target: string, timeout?: Timeout): boolean {
        try {
            let buffer;
            buffer = fs.readFileSync(source);

            if (timeout && timeout.isTimedOut()) {
                vscode.window.showErrorMessage(`Timeout when copyFile: ' ${source} => ${target}`);
                return false;
            }
            fs.writeFileSync(target, buffer);
            return true;
        }
        catch (err) {
            vscode.window.showErrorMessage(`Error with copyFile: '${err.toString()} ${source} => ${target}`);
            return false;
        }
    }

    private normalizePath(dir: string, withDrive: boolean) {
        if (process.platform === 'win32') {
            if (!withDrive)
                return dir.replace(':', '');
            else
                return dir.replace('\\', ':\\');
        } else
            return dir;
    }

    private getPacketStorePath(settings: IHistorySettings) {
        return path.join(settings.historyPath, '.vibe-packets.json');
    }

    private createPacketStore(): IPacketStoreData {
        return {
            version: 1,
            packets: {},
            snapshots: {}
        };
    }

    private readPacketStore(settings: IHistorySettings): IPacketStoreData {
        const storePath = this.getPacketStorePath(settings);
        try {
            if (!fs.existsSync(storePath)) {
                return this.createPacketStore();
            }

            const raw = fs.readFileSync(storePath, 'utf8');
            const parsed = JSON.parse(raw) as IPacketStoreData;
            return {
                version: parsed.version || 1,
                currentPacketId: parsed.currentPacketId,
                lastActivityAt: parsed.lastActivityAt,
                packets: parsed.packets || {},
                snapshots: parsed.snapshots || {}
            };
        } catch (err) {
            logWarn(`Failed to read packet store. Resetting packet metadata. ${err}`);
            return this.createPacketStore();
        }
    }

    private writePacketStore(settings: IHistorySettings, store: IPacketStoreData) {
        const storePath = this.getPacketStorePath(settings);
        this.mkDirRecursive(storePath);
        fs.writeFileSync(storePath, JSON.stringify(store, null, 2), 'utf8');
    }

    private getRelativeHistoryPath(fileName: string, settings: IHistorySettings) {
        return path.relative(settings.historyPath, fileName).replace(/\\/g, '/');
    }

    private getTrackedRelativePath(fileName: string, settings: IHistorySettings) {
        if (!settings.absolute && settings.folder) {
            return this.getRelativePath(fileName).replace(/\\/g, '/');
        }

        return path.resolve(fileName).replace(/\\/g, '/');
    }

    private registerSnapshotPacket(settings: IHistorySettings, sourceFile: string, revisionFile: string, savedAt: Date) {
        if (!settings.packetGrouping) {
            return;
        }

        const store = this.readPacketStore(settings);
        const savedAtIso = savedAt.toISOString();
        const cooldownMs = Math.max(1, settings.packetCooldownMinutes || 2) * 60 * 1000;
        const relativeSnapshotPath = this.getRelativeHistoryPath(revisionFile, settings);
        const relativeFile = this.getTrackedRelativePath(sourceFile, settings);

        let packetId = store.currentPacketId;
        if (store.lastActivityAt) {
            const lastActivity = new Date(store.lastActivityAt).getTime();
            if ((savedAt.getTime() - lastActivity) > cooldownMs) {
                packetId = undefined;
            }
        }

        if (!packetId || !store.packets[packetId]) {
            packetId = `pkt-${savedAtIso.substring(0, 19).replace(/[-:T]/g, '')}`;
            store.packets[packetId] = {
                id: packetId,
                startedAt: savedAtIso,
                lastActivityAt: savedAtIso,
                snapshotCount: 0,
                files: {}
            };
        }

        const packet = store.packets[packetId];
        packet.lastActivityAt = savedAtIso;
        packet.snapshotCount += 1;
        packet.files[relativeFile] = (packet.files[relativeFile] || 0) + 1;

        store.currentPacketId = packetId;
        store.lastActivityAt = savedAtIso;
        store.snapshots[relativeSnapshotPath] = {
            packetId,
            sourceFile: relativeFile,
            savedAt: savedAtIso
        };

        this.writePacketStore(settings, store);
        logInfo(`Snapshot ${relativeSnapshotPath} assigned to ${packetId}`);
    }

    private cleanupPacketMetadata(historyFiles: string[]) {
        const groupedByHistoryRoot = new Map<string, string[]>();

        historyFiles
            .filter(fileName => !!fileName && path.basename(fileName) !== '.vibe-packets.json')
            .forEach(fileName => {
                const historyRoot = this.findHistoryRootForSnapshot(fileName);
                if (!historyRoot) {
                    return;
                }

                if (!groupedByHistoryRoot.has(historyRoot)) {
                    groupedByHistoryRoot.set(historyRoot, []);
                }

                groupedByHistoryRoot.get(historyRoot).push(fileName);
            });

        groupedByHistoryRoot.forEach((files, historyRoot) => {
            const storePath = path.join(historyRoot, '.vibe-packets.json');
            if (!fs.existsSync(storePath)) {
                return;
            }

            try {
                const raw = fs.readFileSync(storePath, 'utf8');
                const store = JSON.parse(raw) as IPacketStoreData;
                let changed = false;

                files.forEach(fileName => {
                    const relativeSnapshotPath = path.relative(historyRoot, fileName).replace(/\\/g, '/');
                    const snapshotInfo = store.snapshots && store.snapshots[relativeSnapshotPath];
                    if (!snapshotInfo) {
                        return;
                    }

                    delete store.snapshots[relativeSnapshotPath];
                    changed = true;

                    const packet = store.packets && store.packets[snapshotInfo.packetId];
                    if (!packet) {
                        return;
                    }

                    packet.snapshotCount = Math.max(0, (packet.snapshotCount || 0) - 1);
                    if (packet.files && packet.files[snapshotInfo.sourceFile]) {
                        packet.files[snapshotInfo.sourceFile] = Math.max(0, packet.files[snapshotInfo.sourceFile] - 1);
                        if (packet.files[snapshotInfo.sourceFile] === 0) {
                            delete packet.files[snapshotInfo.sourceFile];
                        }
                    }

                    if (packet.snapshotCount === 0 || !Object.keys(packet.files || {}).length) {
                        delete store.packets[snapshotInfo.packetId];
                        if (store.currentPacketId === snapshotInfo.packetId) {
                            delete store.currentPacketId;
                            delete store.lastActivityAt;
                        }
                    }
                });

                if (changed) {
                    fs.writeFileSync(storePath, JSON.stringify(store, null, 2), 'utf8');
                }
            } catch (err) {
                logWarn(`Failed to cleanup packet metadata for ${historyRoot}. ${err}`);
            }
        });
    }

    private findHistoryRootForSnapshot(fileName: string) {
        let current = path.dirname(fileName);

        while (current && current !== path.dirname(current)) {
            if (fs.existsSync(path.join(current, '.vibe-packets.json'))) {
                return current;
            }

            current = path.dirname(current);
        }

        return undefined;
    }
}


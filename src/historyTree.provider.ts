import * as vscode from 'vscode';

import { IHistoryFileProperties, HistoryController, IPacketInfo }  from './history.controller';
import { IHistorySettings, HistorySettings } from './history.settings';
import { logInfo, logWarn } from './logger';

// import path = require('path');

const enum EHistoryTreeItem {
    None = 0,
    Control,
    Group,
    Packet,
    FileGroup,
    File
}

const enum EHistoryTreeContentKind {
    Current = 0,
    All,
    Search
}

export default class HistoryTreeProvider implements vscode.TreeDataProvider<HistoryItem>  {

    /* tslint:disable */
    private _onDidChangeTreeData: vscode.EventEmitter<HistoryItem | undefined> = new vscode.EventEmitter<HistoryItem | undefined>();
    readonly onDidChangeTreeData: vscode.Event<HistoryItem | undefined> = this._onDidChangeTreeData.event;
    /* tslint:enable*/

    private currentHistoryFile: string;
    private currentHistoryPath: string;
    private historyFiles: Object; // {yesterday: IHistoryFileProperties[]}
    private selection: HistoryItem;
    private noLimit = false;
    private date;   // calculs result of relative date against now()

    public contentKind: EHistoryTreeContentKind = 0;
    private searchPattern: string;
    private currentSettings: IHistorySettings;
    private emptyStateMessage = 'No history yet for the current file.';
    private packetGroups: {[packetId: string]: {packet: IPacketInfo, files: {[sourceFile: string]: IHistoryFileProperties[]}}};

    constructor(private controller: HistoryController) {
        this.initLocation();
    }

    initLocation(){
        vscode.commands.executeCommand('setContext', 'local-history:treeLocation', HistorySettings.getTreeLocation());
    }

    getSettingsItem(): HistoryItem {
        const settings = this.getEffectiveSettings();
        const scope = this.getScopeLabel();
        const enabled = settings && settings.enabled ? 'History on' : 'History off';
        const packets = settings && settings.packetGrouping
            ? `Packets on (${settings.packetCooldownMinutes}m)`
            : 'Packets off';
        const tooltip = [
            `Scope: ${scope}`,
            enabled,
            packets,
            'Click to change filters and packet settings.'
        ].join('\n');

        return new HistoryItem(this, 'Controls', EHistoryTreeItem.Control, null, tooltip, false, `${scope} | ${enabled} | ${packets}`, tooltip);
    }

    getTreeItem(element: HistoryItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: HistoryItem): Promise<HistoryItem[]> {
        return new Promise(resolve => {
            let items: HistoryItem[] = [];

            if (!element) { // root

                if (!this.historyFiles && !this.packetGroups) {

                    if (!vscode.window.activeTextEditor || !vscode.window.activeTextEditor.document) {
                        this.emptyStateMessage = 'No active editor. Open a saved file to inspect local history.';
                        logWarn(this.emptyStateMessage);
                        items.push(this.getSettingsItem());
                        items.push(new HistoryItem(this, this.emptyStateMessage, EHistoryTreeItem.None));
                        return resolve(items);
                    }

                    const filename = vscode.window.activeTextEditor.document.uri;
                    logInfo(`Tree refresh for active editor: ${filename.toString()}`);
                    const settings = this.controller.getSettings(filename);
                    this.currentSettings = settings;

                    this.loadHistoryFile(filename, settings)
                        .then(() => {
                            items.push(this.getSettingsItem());
                            items.push(...(settings.packetGrouping
                                ? this.loadPacketGroups(this.packetGroups)
                                : this.loadHistoryGroups(this.historyFiles)));
                            resolve(items);
                        });
                } else {
                    items.push(this.getSettingsItem());
                    items.push(...(this.currentSettings && this.currentSettings.packetGrouping
                        ? this.loadPacketGroups(this.packetGroups)
                        : this.loadHistoryGroups(this.historyFiles)));
                    resolve(items);
                }
            } else {
                if (element.kind === EHistoryTreeItem.Group) {
                    this.historyFiles[element.nodeId].forEach((file) => {
                        items.push(new HistoryItem(this, this.getFileLabel(file), EHistoryTreeItem.File,
                            vscode.Uri.file(file.file), element.nodeId, true, this.getTimelineDescription(file), this.getFileTooltip(file)));
                    });
                } else if (element.kind === EHistoryTreeItem.Packet) {
                    const packetGroup = this.packetGroups[element.nodeId];
                    if (packetGroup) {
                        Object.keys(packetGroup.files).sort().forEach(sourceFile => {
                            const snapshots = packetGroup.files[sourceFile];
                            items.push(new HistoryItem(this, sourceFile, EHistoryTreeItem.FileGroup, null,
                                element.nodeId, false, `${snapshots.length} changes`, `Packet ${element.nodeId}` , `${element.nodeId}:${sourceFile}`));
                        });
                    }
                } else if (element.kind === EHistoryTreeItem.FileGroup) {
                    const packetId = element.grp;
                    const sourceFile = element.label;
                    const packetGroup = this.packetGroups[packetId];
                    if (packetGroup && packetGroup.files[sourceFile]) {
                        packetGroup.files[sourceFile].forEach(file => {
                            items.push(new HistoryItem(this, this.getFileLabel(file), EHistoryTreeItem.File,
                                vscode.Uri.file(file.file), packetId, true, this.getTimelineDescription(file), this.getFileTooltip(file), `${packetId}:${file.file}`));
                        });
                    }
                }
                resolve(items);
            }
        });
    }

    private loadHistoryFile(fileName: vscode.Uri, settings: IHistorySettings): Promise<Object> {
        return new Promise((resolve, reject) => {
            const activeEditor = vscode.window.activeTextEditor && vscode.window.activeTextEditor.document;
            if (activeEditor) {
                logInfo(`Loading tree content for ${activeEditor.uri.fsPath || activeEditor.uri.toString()} (scheme=${activeEditor.uri.scheme}, untitled=${activeEditor.isUntitled})`);
            }

            let pattern;
            switch (this.contentKind) {
                case EHistoryTreeContentKind.All:
                    pattern = '**/*.*';
                    break;
                case EHistoryTreeContentKind.Current:
                    pattern = fileName.fsPath;
                    break;
                case EHistoryTreeContentKind.Search:
                    pattern = this.searchPattern;
                    break;
            }

            this.controller.findGlobalHistory(pattern, this.contentKind === EHistoryTreeContentKind.Current, settings, this.noLimit)
                .then(findFiles => {
                    // Current file
                    if (this.contentKind === EHistoryTreeContentKind.Current) {
                        const historyFile = this.controller.decodeFile(fileName.fsPath, settings);
                        this.currentHistoryFile = historyFile && historyFile.file;
                    }
                    this.currentHistoryPath = settings.historyPath;

                    // History files
                    this.historyFiles = {};
                    this.packetGroups = {};

                    let grp = 'new';
                    const files = findFiles;
                    if (!settings.enabled) {
                        this.emptyStateMessage = 'History is disabled for this location. Check local-history.enabled and local-history.path.';
                    } else if (!settings.historyPath) {
                        this.emptyStateMessage = 'No history path resolved for this file.';
                    } else if (this.contentKind === EHistoryTreeContentKind.Current && activeEditor && activeEditor.isUntitled) {
                        this.emptyStateMessage = 'Current editor is untitled. Save the file first to create local history.';
                    } else if (this.contentKind === EHistoryTreeContentKind.Current) {
                        this.emptyStateMessage = 'No history yet for the current file. Make a saved change to create the first snapshot.';
                    } else {
                        this.emptyStateMessage = 'No matching history entries found.';
                    }

                    if (files && files.length) {
                        const decodedFiles = files.map(file => this.controller.decodeFile(file, settings))
                             .sort((f1, f2) => {
                                if (!f1 || !f2)
                                    return 0;
                                if (f1.date > f2.date)
                                    return -1;
                                if (f1.date < f2.date)
                                    return 1;
                                return f1.name.localeCompare(f2.name);
                             });

                        if (settings.packetGrouping) {
                            decodedFiles.forEach(file => this.addPacketGroupEntry(file, settings));
                        } else {
                            decodedFiles.forEach((file, index) => {
                                if (file)
                                    if (grp !== 'Older') {
                                        grp = this.getRelativeDate(file.date);
                                        if (!this.historyFiles[grp])
                                            this.historyFiles[grp] = [file]
                                        else
                                            this.historyFiles[grp].push(file);
                                    } else {
                                        this.historyFiles[grp].push(file);
                                    }
                                // else
                                    // this.historyFiles['failed'].push(files[index]);
                            });
                        }
                    }

                    logInfo(`History lookup pattern="${pattern}" historyPath="${settings.historyPath}" matches=${files ? files.length : 0}`);
                    return resolve(settings.packetGrouping ? this.packetGroups : this.historyFiles);
                })
        })
    }

    private loadHistoryGroups(historyFiles: Object): HistoryItem[] {
        const items = [],
              keys = historyFiles && Object.keys(historyFiles);

        if (keys && keys.length > 0)
            keys.forEach((key) => {
                const item =  new HistoryItem(this, key, EHistoryTreeItem.Group);
                items.push(item);
            });
        else
            items.push(new HistoryItem(this, this.emptyStateMessage, EHistoryTreeItem.None));

        return items;
    }

    private loadPacketGroups(packetGroups: {[packetId: string]: {packet: IPacketInfo, files: {[sourceFile: string]: IHistoryFileProperties[]}}}): HistoryItem[] {
        const items = [],
              keys = packetGroups && Object.keys(packetGroups);

        if (keys && keys.length > 0) {
            keys.sort((left, right) => packetGroups[right].packet.startedAt.localeCompare(packetGroups[left].packet.startedAt))
                .forEach(packetId => {
                    const packet = packetGroups[packetId].packet;
                    const fileCount = Object.keys(packet.files || {}).length;
                    items.push(new HistoryItem(this, this.getPacketLabel(packet), EHistoryTreeItem.Packet, null, null, false,
                        `${fileCount} files, ${packet.snapshotCount} changes`, this.getPacketTooltip(packet), packetId));
                });
        } else {
            items.push(new HistoryItem(this, this.emptyStateMessage, EHistoryTreeItem.None));
        }

        return items;
    }

    private addPacketGroupEntry(file: IHistoryFileProperties, settings: IHistorySettings) {
        if (!file || !file.file) {
            return;
        }

        const packetMeta = this.controller.getPacketInfo(file.file, settings);
        const packetId = packetMeta && packetMeta.packetId
            ? packetMeta.packetId
            : `legacy-${file.date.toISOString().substring(0, 19).replace(/[-:T]/g, '')}`;
        const sourceFile = packetMeta && packetMeta.sourceFile
            ? packetMeta.sourceFile
            : `${file.name}${file.ext}`;

        if (!this.packetGroups[packetId]) {
            const packetStore = this.controller.getPacketStore(vscode.window.activeTextEditor.document.uri);
            this.packetGroups[packetId] = {
                packet: packetStore[packetId] || {
                    id: packetId,
                    startedAt: file.date.toISOString(),
                    lastActivityAt: file.date.toISOString(),
                    snapshotCount: 0,
                    files: {}
                },
                files: {}
            };
        }

        if (!this.packetGroups[packetId].files[sourceFile]) {
            this.packetGroups[packetId].files[sourceFile] = [];
        }

        this.packetGroups[packetId].files[sourceFile].push(file);
    }

    private getFileLabel(file: IHistoryFileProperties) {
        return `${file.name}${file.ext}`;
    }

    private getTimelineDescription(file: IHistoryFileProperties) {
        return this.getRelativeAge(file.date);
    }

    private getPacketTooltip(packet: IPacketInfo) {
        return `Packet ${packet.id}\nStarted: ${packet.startedAt}\nLast activity: ${packet.lastActivityAt}\nSnapshots: ${packet.snapshotCount}`;
    }

    private getPacketLabel(packet: IPacketInfo) {
        return `Packet ${this.getRelativeAge(new Date(packet.startedAt))}`;
    }

    private getFileTooltip(file: IHistoryFileProperties) {
        const absoluteTime = this.currentSettings && file.date
            ? file.date.toLocaleString(this.currentSettings.dateLocale)
            : '';
        return `${file.file}\n${this.getRelativeAge(file.date)}${absoluteTime ? ` - ${absoluteTime}` : ''}`;
    }

    private getRelativeAge(fileDate: Date) {
        const elapsedMs = Date.now() - fileDate.getTime();
        const minute = 60 * 1000;
        const hour = 60 * minute;
        const day = 24 * hour;

        if (elapsedMs < minute)
            return 'Just now';
        if (elapsedMs < hour)
            return `${Math.max(1, Math.floor(elapsedMs / minute))}m ago`;
        if (elapsedMs < day)
            return `${Math.max(1, Math.floor(elapsedMs / hour))}h ago`;
        if (elapsedMs < day * 30)
            return `${Math.max(1, Math.floor(elapsedMs / day))}d ago`;

        const month = Math.max(1, Math.floor(elapsedMs / (day * 30)));
        if (month < 12)
            return `${month}mo ago`;

        return `${Math.max(1, Math.floor(month / 12))}y ago`;
    }

    private getRelativeDate(fileDate: Date) {
        const hour = 60 * 60,
              day = hour * 24,
              ref = fileDate.getTime() / 1000;

        if (!this.date) {
            const dt = new Date(),
                  now =  dt.getTime() / 1000,
                  today = dt.setHours(0,0,0,0) / 1000; // clear current hour
            this.date = {
                now:  now,
                today: today,
                week: today - ((dt.getDay() || 7) - 1) * day, //  1st day of week (week start monday)
                month: dt.setDate(1) / 1000,        // 1st day of current month
                eLastMonth: dt.setDate(0) / 1000,          // last day of previous month
                lastMonth: dt.setDate(1) / 1000     // 1st day of previous month
            }
        }

        if (this.date.now - ref < hour)
            return 'In the last hour'
        else if (ref > this.date.today)
            return 'Today'
        else if (ref > this.date.today - day)
            return 'Yesterday'
        else if (ref > this.date.week)
            return 'This week'
        else if (ref > this.date.week - (day * 7))
            return 'Last week'
        else if (ref > this.date.month)
            return 'This month'
        else if (ref > this.date.lastMonth)
            return 'Last month'
        else
            return 'Older'
    }

    // private changeItemSelection(select, item) {
    //     if (select)
    //          item.iconPath = this.selectIconPath
    //      else
    //          delete item.iconPath;
    // }

    private redraw() {
        this._onDidChangeTreeData.fire();
    }

    private getScopeLabel() {
        switch (this.contentKind) {
            case EHistoryTreeContentKind.All:
                return 'All files';
            case EHistoryTreeContentKind.Search:
                return `Search: ${this.searchPattern || '*'}`;
            default:
                return 'Current file';
        }
    }

    private getEffectiveSettings(): IHistorySettings {
        if (this.currentSettings) {
            return this.currentSettings;
        }

        if (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document) {
            return this.controller.getSettings(vscode.window.activeTextEditor.document.uri);
        }

        const workspaceFolder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length
            ? vscode.workspace.workspaceFolders[0].uri
            : vscode.Uri.file(vscode.workspace.rootPath || process.cwd());
        return this.controller.getSettings(workspaceFolder);
    }

    public changeActiveFile() {
        if (!vscode.window.activeTextEditor)
            return;

        const filename = vscode.window.activeTextEditor.document.uri;
        const settings = this.controller.getSettings(filename);
        const prop = this.controller.decodeFile(filename.fsPath, settings, false);
        if (!prop || prop.file !== this.currentHistoryFile)
            this.refresh();
    }

    public refresh(noLimit = false): void {
        delete this.selection;
        this.noLimit = noLimit;
        delete this.currentHistoryFile;
        delete this.currentHistoryPath;
        delete this.historyFiles;
        delete this.packetGroups;
        delete this.date;
        this._onDidChangeTreeData.fire();
    }

    public more(): void {
        if (!this.noLimit) {
            this.refresh(true);
        }
    }

    public setRetentionDays(): void {
        const activeUri = vscode.window.activeTextEditor && vscode.window.activeTextEditor.document
            ? vscode.window.activeTextEditor.document.uri
            : undefined;
        const config = vscode.workspace.getConfiguration('local-history', activeUri);
        const current = <number>config.get('daysLimit');

        const options = [
            {label: '7 days', value: 7},
            {label: '30 days', value: 30},
            {label: '90 days', value: 90},
            {label: 'Keep forever', value: 0},
            {label: 'Custom...', value: -1}
        ];

        vscode.window.showQuickPick(options, {
            placeHolder: `Retention window (current: ${current || 0} days)`
        }).then(async selection => {
            if (!selection) {
                return;
            }

            let days = selection.value;
            if (days === -1) {
                const input = await vscode.window.showInputBox({
                    prompt: 'Keep history for how many days? Use 0 to disable cleanup.',
                    value: `${current || 30}`,
                    validateInput: value => /^\d+$/.test(value) ? undefined : 'Enter a non-negative integer.'
                });

                if (input == null) {
                    return;
                }

                days = Number.parseInt(input, 10);
            }

            const target = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length
                ? vscode.ConfigurationTarget.Workspace
                : vscode.ConfigurationTarget.Global;

            await config.update('daysLimit', days, target);

            if (activeUri) {
                await this.controller.purgeExpiredHistory(activeUri);
            }

            this.controller.clearSettings();
            this.refresh(this.noLimit);
            vscode.window.showInformationMessage(days > 0
                ? `Vibe Local History will keep snapshots for ${days} day(s).`
                : 'Vibe Local History cleanup disabled.');
        });
    }

    public toggleEnabled(): void {
        const activeUri = vscode.window.activeTextEditor && vscode.window.activeTextEditor.document
            ? vscode.window.activeTextEditor.document.uri
            : undefined;
        const config = vscode.workspace.getConfiguration('local-history', activeUri);
        const current = <number>config.get('enabled');
        const next = current === 0 ? 1 : 0;
        const target = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length
            ? vscode.ConfigurationTarget.Workspace
            : vscode.ConfigurationTarget.Global;

        config.update('enabled', next, target).then(() => {
            this.controller.clearSettings();
            this.refresh(this.noLimit);
            logInfo(`History ${next === 0 ? 'disabled' : 'enabled'} from toolbar toggle.`);
            vscode.window.showInformationMessage(next === 0
                ? 'Vibe Local History disabled.'
                : 'Vibe Local History enabled.');
        });
    }

    public togglePacketGrouping(): void {
        const activeUri = vscode.window.activeTextEditor && vscode.window.activeTextEditor.document
            ? vscode.window.activeTextEditor.document.uri
            : undefined;
        const config = vscode.workspace.getConfiguration('local-history', activeUri);
        const current = <boolean>config.get('packetGrouping');
        const target = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length
            ? vscode.ConfigurationTarget.Workspace
            : vscode.ConfigurationTarget.Global;

        config.update('packetGrouping', !current, target).then(() => {
            if (!current) {
                this.contentKind = EHistoryTreeContentKind.All;
            }
            this.controller.clearSettings();
            this.refresh(this.noLimit);
            vscode.window.showInformationMessage(!current
                ? 'Smart packet grouping enabled.'
                : 'Smart packet grouping disabled.');
        });
    }

    public setPacketCooldown(): void {
        const activeUri = vscode.window.activeTextEditor && vscode.window.activeTextEditor.document
            ? vscode.window.activeTextEditor.document.uri
            : undefined;
        const config = vscode.workspace.getConfiguration('local-history', activeUri);
        const current = <number>config.get('packetCooldownMinutes');
        const target = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length
            ? vscode.ConfigurationTarget.Workspace
            : vscode.ConfigurationTarget.Global;

        vscode.window.showInputBox({
            prompt: 'Packet cooldown in minutes. If no file changes happen during this time, a new packet starts.',
            value: `${current || 2}`,
            validateInput: value => /^\d+$/.test(value) && Number.parseInt(value, 10) >= 1
                ? undefined
                : 'Enter an integer greater than or equal to 1.'
        }).then(value => {
            if (!value) {
                return;
            }

            config.update('packetCooldownMinutes', Number.parseInt(value, 10), target).then(() => {
                this.controller.clearSettings();
                this.refresh(this.noLimit);
                vscode.window.showInformationMessage(`Packet cooldown set to ${value} minute(s).`);
            });
        });
    }

    public openControls(): void {
        const settings = this.getEffectiveSettings();
        const scopeLabel = this.getScopeLabel();
        const packetLabel = settings && settings.packetGrouping ? 'Disable smart packet grouping' : 'Enable smart packet grouping';
        const enabledLabel = settings && settings.enabled ? 'Disable history tracking' : 'Enable history tracking';

        vscode.window.showQuickPick([
            {label: 'Current file', description: 'Show history for the active file only', action: 'scope-current'},
            {label: 'All files', description: 'Show all tracked files in the workspace', action: 'scope-all'},
            {label: 'Specific file search', description: 'Filter history by a custom glob pattern', action: 'scope-search'},
            {label: enabledLabel, description: 'Toggle snapshot capture on or off', action: 'toggle-enabled'},
            {label: 'Set retention days', description: 'Change automatic cleanup window', action: 'retention'},
            {label: packetLabel, description: 'Group nearby changes into rolling packets', action: 'toggle-packets'},
            {label: 'Set packet cooldown', description: `Current: ${settings.packetCooldownMinutes || 2} minute(s)`, action: 'packet-cooldown'},
            {label: 'Refresh view', description: `Current scope: ${scopeLabel}`, action: 'refresh'}
        ], {
            placeHolder: 'Vibe Local History controls'
        }).then(selection => {
            if (!selection) {
                return;
            }

            switch (selection.action) {
                case 'scope-current':
                    return this.forCurrentFile();
                case 'scope-all':
                    return this.forAll();
                case 'scope-search':
                    return this.forSpecificFile();
                case 'toggle-enabled':
                    return this.toggleEnabled();
                case 'retention':
                    return this.setRetentionDays();
                case 'toggle-packets':
                    return this.togglePacketGrouping();
                case 'packet-cooldown':
                    return this.setPacketCooldown();
                default:
                    return this.refresh(this.noLimit);
            }
        });
    }

    public deleteAll(): void {
        let message;
        switch (this.contentKind) {
            case EHistoryTreeContentKind.All:
                message = `Delete all history - ${this.currentHistoryPath}?`
                break;
            case EHistoryTreeContentKind.Current:
                message = `Delete history for ${this.currentHistoryFile} ?`
                break;
            case EHistoryTreeContentKind.Search:
                message = `Delete history for ${this.searchPattern} ?`
                break;
        }

        vscode.window.showInformationMessage(message, {modal: true}, {title: 'Yes'}, {title: 'No', isCloseAffordance: true})
            .then(sel => {
                if (sel.title === 'Yes') {
                    switch (this.contentKind) {
                        case EHistoryTreeContentKind.All:
                            // Delete all history
                            this.controller.deleteAll(this.currentHistoryPath)
                            .then(() => this.refresh())
                            .catch(err => vscode.window.showErrorMessage(`Delete failed: ${err}`));
                            break;
                        case EHistoryTreeContentKind.Current:
                            // delete history for current file
                            this.controller.deleteHistory(this.currentHistoryFile)
                            .then(() => this.refresh())
                            .catch(err => vscode.window.showErrorMessage(`Delete failed: ${err}`));
                            break;
                        case EHistoryTreeContentKind.Search:
                            // Delete visible history files
                            const keys = Object.keys(this.historyFiles);
                            if (keys && keys.length) {
                                const items = [];
                                keys.forEach(key => items.push(...this.historyFiles[key].map(item => item.file)));
                                this.controller.deleteFiles(items)
                                    .then(() => this.refresh())
                                    .catch(err => vscode.window.showErrorMessage(`Delete failed: ${err}`));
                            }
                            break;
                    }
                }
            },
                (err => { return; })
            );
    }

    public show(file: vscode.Uri): void {
        vscode.commands.executeCommand('vscode.open', file);
    }

    public showSide(element: HistoryItem): void {
        if (element.kind === EHistoryTreeItem.File)
            vscode.commands.executeCommand('vscode.open', element.file, Math.min(vscode.window.activeTextEditor.viewColumn + 1, 3));
    }

    public delete(element: HistoryItem): void {
        if (element.kind === EHistoryTreeItem.File)
            this.controller.deleteFile(element.file.fsPath)
                .then(() => this.refresh());
        else  if (element.kind === EHistoryTreeItem.Group) {
            this.controller.deleteFiles(
                    this.historyFiles[element.label].map((value: IHistoryFileProperties) => value.file))
                .then(() => this.refresh());
        }
    }

    public compareToCurrent(element: HistoryItem): void {
        if (element.kind === EHistoryTreeItem.File) {
            let currRange;

            if (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document &&
                vscode.window.activeTextEditor.document.fileName === this.currentHistoryFile) {

                const currPos = vscode.window.activeTextEditor.selection.active;
                currRange = new vscode.Range(currPos, currPos);
            };
            this.controller.compare(element.file, vscode.Uri.file(this.currentHistoryFile), null, currRange);
        }
    }

    public select(element: HistoryItem): void {
        if (element.kind === EHistoryTreeItem.File) {
            if (this.selection)
                delete this.selection.iconPath;
            this.selection = element;
            this.redraw();
        }
    }
    public compare(element: HistoryItem): void {
        if (element.kind === EHistoryTreeItem.File) {
            if (this.selection)
                this.controller.compare(element.file, this.selection.file);
            else
                vscode.window.showErrorMessage('Select a history files to compare with');
        }
    }

    public restore(element: HistoryItem): void {
        if (element.kind === EHistoryTreeItem.File) {
            this.controller.restore(element.file)
                .then(() => this.refresh())
                .catch(err => vscode.window.showErrorMessage(`Restore ${element.file.fsPath} failed. Error: ${err}`));
        }
    }

    public forCurrentFile(): void{
        this.contentKind = EHistoryTreeContentKind.Current;
        this.refresh();
    }
    public forAll(): void{
        this.contentKind = EHistoryTreeContentKind.All;
        this.refresh();
    }
    public forSpecificFile(): void {
        vscode.window.showInputBox({prompt: 'Specify what to search:', value: '**/*myFile*.*', valueSelection: [4,10]})
            .then(value => {
                if (value) {
                    this.searchPattern = value;
                    this.contentKind = EHistoryTreeContentKind.Search;
                    this.refresh();
                }
            });
    }
}

class HistoryItem extends vscode.TreeItem {

    public readonly kind: EHistoryTreeItem;
    public readonly file: vscode.Uri;
    public readonly grp: string;
    public readonly nodeId: string;

    constructor(provider: HistoryTreeProvider, label: string = '', kind: EHistoryTreeItem, file?: vscode.Uri,
        grp?: string, showIcon?: boolean, description?: string, tooltip?: string, nodeId?: string) {

        super(label, kind === EHistoryTreeItem.Group || kind === EHistoryTreeItem.Packet || kind === EHistoryTreeItem.FileGroup
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None);

        this.kind = kind;
        this.file = file;
        this.grp = this.kind !== EHistoryTreeItem.None ? grp : undefined;
        this.nodeId = nodeId || label;

        switch (this.kind) {
            case EHistoryTreeItem.Control:
                this.contextValue = 'localHistoryControl';
                this.description = description;
                this.tooltip = tooltip;
                this.command = {
                    command: 'treeLocalHistory.openControls',
                    title: 'Open controls'
                };
                break;
            case EHistoryTreeItem.File:
                this.contextValue = 'localHistoryItem';
                this.description = description;
                this.tooltip = tooltip || file.fsPath;
                this.resourceUri = file;
                if (showIcon)
                    this.iconPath = false;
                break;
            case EHistoryTreeItem.Group:
            case EHistoryTreeItem.Packet:
            case EHistoryTreeItem.FileGroup:
                this.contextValue = 'localHistoryGrp';
                this.description = description;
                this.tooltip = tooltip;
                break;
            default: // EHistoryTreeItem.None
                this.contextValue = 'localHistoryNone';
                this.tooltip = grp;
        }

        // TODO: if current === file
        if (this.kind === EHistoryTreeItem.Control) {
            return;
        }

        if (provider.contentKind === EHistoryTreeContentKind.Current) {
            this.command = this.kind === EHistoryTreeItem.File ? {
                command: 'treeLocalHistory.compareToCurrentEntry',
                title: 'Compare with current version',
                arguments: [this]
            } : undefined;
        } else {
            this.command = this.kind === EHistoryTreeItem.File ? {
                command: 'treeLocalHistory.showEntry',
                title: 'Open Local History',
                arguments: [file]
            } : undefined;
        }
    }
}

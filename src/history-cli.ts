#!/usr/bin/env node
import fs = require('fs');
import path = require('path');
import crypto = require('crypto');
import glob = require('glob');

interface IRevisionEntry {
    index: number;
    revisionPath: string;
    timestamp: string;
    date: Date;
    workspaceFile: string;
    relativeFile: string;
    packetId?: string;
}

interface IContext {
    cwd: string;
    workspaceRoot: string;
    historyRoot: string;
}

interface IPacketInfo {
    id: string;
    startedAt: string;
    lastActivityAt: string;
    snapshotCount: number;
    files: {[relativeFile: string]: number};
}

interface IPacketSnapshotInfo {
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

const TIMESTAMP_SUFFIX = /_(\d{14})(\.[^.]*)$/;

function main() {
    const args = process.argv.slice(2);
    const command = args[0];

    if (!command || command === 'help' || command === '--help' || command === '-h') {
        printHelp();
        return;
    }

    const cwd = process.cwd();
    const historyOverride = extractOption(args, '--history-dir');
    const context = resolveContext(cwd, historyOverride);

    try {
        switch (command) {
            case 'status':
            case 'st':
                runStatus(context, args.slice(1));
                return;
            case 'log':
            case 'lg':
                runLog(context, args.slice(1));
                return;
            case 'packets':
            case 'pk':
                runPackets(context, args.slice(1));
                return;
            case 'show':
            case 'sh':
                runShow(context, args.slice(1));
                return;
            case 'diff':
            case 'di':
                runDiff(context, args.slice(1));
                return;
            case 'restore':
            case 'rs':
                runRestore(context, args.slice(1));
                return;
            default:
                fail(`Unknown command: ${command}`);
        }
    } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
    }
}

function printHelp() {
    console.log(`vibe-history <command> [args]

Commands:
  status|st [--all] [path]        Show tracked files changed since latest snapshot
  packets|pk [path]               List packet ids and grouped change counts
  log|lg <file|packet:id>         List snapshots for a file or packet
  show|sh <file|packet:id> [rev]  Print a snapshot or packet summary
  diff|di <file|packet:id> [...]  Diff current vs rev, rev vs rev2, or packet vs workspace
  restore|rs <file|packet:id>     Restore a file snapshot or an entire packet

Options:
  --history-dir <path>            Override the .history directory root

Revision syntax:
  Use numeric indexes from 'log'. 0 is the latest snapshot.
  Packet references accept packet:<id> or pkt-YYYYMMDDHHMMSS.`);
}

function resolveContext(cwd: string, historyOverride?: string): IContext {
    if (historyOverride) {
        const historyRoot = path.resolve(cwd, historyOverride);
        if (!fs.existsSync(historyRoot)) {
            throw new Error(`History directory not found: ${historyRoot}`);
        }

        return {
            cwd,
            workspaceRoot: path.dirname(historyRoot),
            historyRoot
        };
    }

    let current = cwd;
    while (true) {
        const candidate = path.join(current, '.history');
        if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
            return {
                cwd,
                workspaceRoot: current,
                historyRoot: candidate
            };
        }

        const parent = path.dirname(current);
        if (parent === current) {
            throw new Error('Unable to find .history directory. Run the command inside a tracked workspace or pass --history-dir.');
        }
        current = parent;
    }
}

function runStatus(context: IContext, args: string[]) {
    const showAll = hasFlag(args, '--all');
    const targetArg = firstPositional(args);
    const filterPrefix = targetArg ? normalizeRelative(context, targetArg) : '';
    const latestByFile = collectLatestSnapshots(context);
    const lines: string[] = [];

    Object.keys(latestByFile)
        .sort()
        .forEach(relativeFile => {
            if (filterPrefix && relativeFile.indexOf(filterPrefix) !== 0) {
                return;
            }

            const revision = latestByFile[relativeFile];
            const currentFile = revision.workspaceFile;
            if (!fs.existsSync(currentFile)) {
                lines.push(`D ${relativeFile}`);
                return;
            }

            const currentHash = sha1File(currentFile);
            const historyHash = sha1File(revision.revisionPath);
            const changed = currentHash !== historyHash;

            if (changed) {
                lines.push(`M ${relativeFile}`);
            } else if (showAll) {
                lines.push(`= ${relativeFile}`);
            }
        });

    if (!lines.length) {
        console.log(showAll ? 'No tracked files found.' : 'Working tree clean relative to local history.');
        return;
    }

    console.log(lines.join('\n'));
}

function runLog(context: IContext, args: string[]) {
    const fileArg = firstPositional(args);
    if (!fileArg) {
        throw new Error('log requires a file path.');
    }

    const revisions = isPacketRef(fileArg)
        ? getRevisionsForPacket(context, fileArg)
        : getRevisionsForFile(context, fileArg);
    if (!revisions.length) {
        console.log('No snapshots found.');
        return;
    }

    revisions.forEach(revision => {
        console.log(`${revision.index}  ${formatRelativeAge(revision.date)}  ${formatLocalDate(revision.date)}  ${revision.packetId || '-'}  ${revision.relativeFile}`);
    });
}

function runPackets(context: IContext, args: string[]) {
    const packetStore = readPacketStore(context);
    const fileArg = firstPositional(args);
    const filterFile = fileArg ? normalizeRelative(context, fileArg) : undefined;
    const packets = Object.keys(packetStore.packets)
        .map(id => packetStore.packets[id])
        .filter(packet => !filterFile || Boolean(packet.files[filterFile]))
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt));

    if (!packets.length) {
        console.log('No packets found.');
        return;
    }

    packets.forEach(packet => {
        const fileCount = Object.keys(packet.files || {}).length;
        console.log(`${packet.id}  ${formatRelativeAge(new Date(packet.startedAt))}  ${fileCount} files  ${packet.snapshotCount} changes`);
    });
}

function runShow(context: IContext, args: string[]) {
    const fileArg = firstPositional(args);
    if (!fileArg) {
        throw new Error('show requires a file path.');
    }

    const positional = positionalArgs(args);
    if (isPacketRef(fileArg)) {
        const packetId = normalizePacketRef(fileArg);
        const revisions = getRevisionsForPacket(context, fileArg);
        if (!revisions.length) {
            throw new Error(`No snapshots found for packet: ${packetId}`);
        }

        const latestByFile = collectLatestByFile(revisions);
        const packetStore = readPacketStore(context);
        const packet = packetStore.packets[packetId];
        const lines = [
            `packet ${packetId}`,
            `started ${packet && packet.startedAt ? packet.startedAt : '-'}`,
            `lastActivity ${packet && packet.lastActivityAt ? packet.lastActivityAt : '-'}`,
            `files ${Object.keys(latestByFile).length}`,
            `snapshots ${revisions.length}`,
            ''
        ];

        Object.keys(latestByFile).sort().forEach(relativeFile => {
            const revision = latestByFile[relativeFile];
            lines.push(`${relativeFile} @ ${revision.index} ${formatLocalDate(revision.date)}`);
        });

        process.stdout.write(lines.join('\n'));
        return;
    }

    const revisions = getRevisionsForFile(context, fileArg);
    if (!revisions.length) {
        throw new Error('No snapshots found for file.');
    }

    const revision = resolveRevision(revisions, positional[1] || '0');
    process.stdout.write(readText(revision.revisionPath));
}

function runDiff(context: IContext, args: string[]) {
    const fileArg = firstPositional(args);
    if (!fileArg) {
        throw new Error('diff requires a file path.');
    }

    if (isPacketRef(fileArg)) {
        const revisions = getRevisionsForPacket(context, fileArg);
        if (!revisions.length) {
            throw new Error(`No snapshots found for packet: ${normalizePacketRef(fileArg)}`);
        }

        const latestByFile = collectLatestByFile(revisions);
        const diffBlocks: string[] = [];
        Object.keys(latestByFile).sort().forEach(relativeFile => {
            const revision = latestByFile[relativeFile];
            if (!fs.existsSync(revision.workspaceFile)) {
                diffBlocks.push(`# ${relativeFile}`);
                diffBlocks.push(`Working file missing: ${revision.workspaceFile}`);
                diffBlocks.push('');
                return;
            }

            diffBlocks.push(`# ${relativeFile}`);
            diffBlocks.push(...buildSimpleDiff(`${relativeFile}@${revision.packetId || revision.index}`, readText(revision.revisionPath), relativeFile, readText(revision.workspaceFile)));
            diffBlocks.push('');
        });

        console.log(diffBlocks.join('\n').trim());
        return;
    }

    const positional = positionalArgs(args);
    const revisions = getRevisionsForFile(context, fileArg);
    if (!revisions.length) {
        throw new Error('No snapshots found for file.');
    }

    const relativeFile = revisions[0].relativeFile;
    const currentFile = revisions[0].workspaceFile;

    let leftLabel: string;
    let rightLabel: string;
    let leftContent: string;
    let rightContent: string;

    if (positional.length >= 3) {
        const leftRevision = resolveRevision(revisions, positional[1]);
        const rightRevision = resolveRevision(revisions, positional[2]);
        leftLabel = `${relativeFile}@${leftRevision.index}`;
        rightLabel = `${relativeFile}@${rightRevision.index}`;
        leftContent = readText(leftRevision.revisionPath);
        rightContent = readText(rightRevision.revisionPath);
    } else {
        const revision = resolveRevision(revisions, positional[1] || '0');
        if (!fs.existsSync(currentFile)) {
            throw new Error(`Working file not found: ${currentFile}`);
        }

        leftLabel = `${relativeFile}@${revision.index}`;
        rightLabel = relativeFile;
        leftContent = readText(revision.revisionPath);
        rightContent = readText(currentFile);
    }

    const diffLines = buildSimpleDiff(leftLabel, leftContent, rightLabel, rightContent);
    console.log(diffLines.join('\n'));
}

function runRestore(context: IContext, args: string[]) {
    const fileArg = firstPositional(args);
    if (!fileArg) {
        throw new Error('restore requires a file path.');
    }

    if (isPacketRef(fileArg)) {
        const revisions = getRevisionsForPacket(context, fileArg);
        if (!revisions.length) {
            throw new Error(`No snapshots found for packet: ${normalizePacketRef(fileArg)}`);
        }

        const latestByFile = collectLatestByFile(revisions);
        Object.keys(latestByFile).forEach(relativeFile => {
            const revision = latestByFile[relativeFile];
            ensureDirectory(path.dirname(revision.workspaceFile));
            fs.copyFileSync(revision.revisionPath, revision.workspaceFile);
        });

        console.log(`Restored ${Object.keys(latestByFile).length} files from ${normalizePacketRef(fileArg)}.`);
        return;
    }

    const positional = positionalArgs(args);
    const revisions = getRevisionsForFile(context, fileArg);
    if (!revisions.length) {
        throw new Error('No snapshots found for file.');
    }

    const revision = resolveRevision(revisions, positional[1] || '0');
    const targetFile = revision.workspaceFile;
    ensureDirectory(path.dirname(targetFile));
    fs.copyFileSync(revision.revisionPath, targetFile);
    console.log(`Restored ${revision.relativeFile} from snapshot ${revision.index}.`);
}

function collectLatestSnapshots(context: IContext): {[relativeFile: string]: IRevisionEntry} {
    const entries: {[relativeFile: string]: IRevisionEntry} = {};
    const files = glob.sync('**/*', {cwd: context.historyRoot, absolute: true, nodir: true});

    files.forEach(file => {
        const parsed = parseRevision(context, file);
        if (!parsed) {
            return;
        }

        const current = entries[parsed.relativeFile];
        if (!current || parsed.timestamp > current.timestamp) {
            entries[parsed.relativeFile] = parsed;
        }
    });

    Object.keys(entries).forEach((key, index) => {
        entries[key].index = 0;
    });

    return entries;
}

function getRevisionsForFile(context: IContext, fileArg: string): IRevisionEntry[] {
    const relativeFile = normalizeRelative(context, fileArg);
    const parsed = path.parse(relativeFile);
    const pattern = path.join(parsed.dir, `${parsed.name}_*${parsed.ext}`).replace(/\\/g, '/');
    const files = glob.sync(pattern, {cwd: context.historyRoot.replace(/\\/g, '/'), absolute: true, nodir: true});

    const revisions = files
        .map(file => parseRevision(context, file))
        .filter(item => item && item.relativeFile === relativeFile)
        .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
        .map((item, index) => {
            item.index = index;
            return item;
        });

    return revisions;
}

function getRevisionsForPacket(context: IContext, packetRef: string): IRevisionEntry[] {
    const packetId = normalizePacketRef(packetRef);
    const packetStore = readPacketStore(context);

    const revisions = Object.keys(packetStore.snapshots || {})
        .filter(relativeSnapshotPath => packetStore.snapshots[relativeSnapshotPath].packetId === packetId)
        .map(relativeSnapshotPath => path.join(context.historyRoot, relativeSnapshotPath))
        .filter(revisionPath => fs.existsSync(revisionPath))
        .map(revisionPath => parseRevision(context, revisionPath))
        .filter(revision => !!revision)
        .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
        .map((revision, index) => {
            revision.index = index;
            return revision;
        });

    return revisions;
}

function parseRevision(context: IContext, revisionPath: string): IRevisionEntry {
    const relative = path.relative(context.historyRoot, revisionPath);
    const match = relative.match(TIMESTAMP_SUFFIX);
    if (!match) {
        return null;
    }

    const timestamp = match[1];
    const ext = match[2];
    const withoutSuffix = relative.slice(0, relative.length - match[0].length);
    const relativeFile = `${withoutSuffix}${ext}`.replace(/\\/g, '/');
    const packetStore = readPacketStore(context);
    const packetMeta = packetStore.snapshots[relative.replace(/\\/g, '/')];

    return {
        index: -1,
        revisionPath,
        timestamp,
        date: parseTimestamp(timestamp),
        workspaceFile: path.join(context.workspaceRoot, relativeFile),
        relativeFile,
        packetId: packetMeta && packetMeta.packetId
    };
}

function parseTimestamp(timestamp: string): Date {
    return new Date(
        Number.parseInt(timestamp.slice(0, 4), 10),
        Number.parseInt(timestamp.slice(4, 6), 10) - 1,
        Number.parseInt(timestamp.slice(6, 8), 10),
        Number.parseInt(timestamp.slice(8, 10), 10),
        Number.parseInt(timestamp.slice(10, 12), 10),
        Number.parseInt(timestamp.slice(12, 14), 10)
    );
}

function resolveRevision(revisions: IRevisionEntry[], revisionRef: string): IRevisionEntry {
    if (revisionRef.startsWith('packet:')) {
        const packetId = revisionRef.substring('packet:'.length);
        const packetRevision = revisions.find(revision => revision.packetId === packetId);
        if (!packetRevision) {
            throw new Error(`Packet not found for file: ${packetId}`);
        }
        return packetRevision;
    }

    if (revisionRef.startsWith('pkt-')) {
        const packetRevision = revisions.find(revision => revision.packetId === revisionRef);
        if (!packetRevision) {
            throw new Error(`Packet not found for file: ${revisionRef}`);
        }
        return packetRevision;
    }

    const index = Number.parseInt(revisionRef, 10);
    if (Number.isNaN(index) || index < 0 || index >= revisions.length) {
        throw new Error(`Invalid revision index: ${revisionRef}`);
    }

    return revisions[index];
}

function collectLatestByFile(revisions: IRevisionEntry[]): {[relativeFile: string]: IRevisionEntry} {
    const latestByFile: {[relativeFile: string]: IRevisionEntry} = {};

    revisions.forEach(revision => {
        if (!latestByFile[revision.relativeFile] || revision.timestamp > latestByFile[revision.relativeFile].timestamp) {
            latestByFile[revision.relativeFile] = revision;
        }
    });

    return latestByFile;
}

function formatRelativeAge(date: Date): string {
    const elapsedMs = Date.now() - date.getTime();
    const minute = 60 * 1000;
    const hour = 60 * minute;
    const day = 24 * hour;

    if (elapsedMs < minute) {
        return 'just-now';
    }
    if (elapsedMs < hour) {
        return `${Math.max(1, Math.floor(elapsedMs / minute))}m-ago`;
    }
    if (elapsedMs < day) {
        return `${Math.max(1, Math.floor(elapsedMs / hour))}h-ago`;
    }
    return `${Math.max(1, Math.floor(elapsedMs / day))}d-ago`;
}

function formatLocalDate(date: Date): string {
    const pad = (value: number) => value.toString().padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function buildSimpleDiff(leftLabel: string, leftContent: string, rightLabel: string, rightContent: string): string[] {
    const leftLines = leftContent.replace(/\r\n/g, '\n').split('\n');
    const rightLines = rightContent.replace(/\r\n/g, '\n').split('\n');
    const maxLength = Math.max(leftLines.length, rightLines.length);
    const result = [`--- ${leftLabel}`, `+++ ${rightLabel}`];

    for (let index = 0; index < maxLength; index++) {
        const left = leftLines[index];
        const right = rightLines[index];

        if (left === right) {
            continue;
        }

        if (left !== undefined) {
            result.push(`-${left}`);
        }

        if (right !== undefined) {
            result.push(`+${right}`);
        }
    }

    if (result.length === 2) {
        result.push('No differences.');
    }

    return result;
}

function sha1File(filePath: string): string {
    const data = fs.readFileSync(filePath);
    return crypto.createHash('sha1').update(data).digest('hex');
}

function normalizeRelative(context: IContext, inputPath: string): string {
    const absolute = path.resolve(context.cwd, inputPath);
    const relative = path.relative(context.workspaceRoot, absolute);
    if (relative.startsWith('..')) {
        throw new Error(`Path is outside workspace root: ${inputPath}`);
    }

    return relative.replace(/\\/g, '/');
}

function readText(filePath: string): string {
    return fs.readFileSync(filePath, 'utf8');
}

function isPacketRef(value: string): boolean {
    return !!value && (value.indexOf('packet:') === 0 || value.indexOf('pkt-') === 0);
}

function normalizePacketRef(value: string): string {
    return value.indexOf('packet:') === 0 ? value.substring('packet:'.length) : value;
}

function readPacketStore(context: IContext): IPacketStoreData {
    const storePath = path.join(context.historyRoot, '.vibe-packets.json');
    if (!fs.existsSync(storePath)) {
        return {
            version: 1,
            packets: {},
            snapshots: {}
        };
    }

    try {
        const raw = fs.readFileSync(storePath, 'utf8');
        const parsed = JSON.parse(raw) as IPacketStoreData;
        return {
            version: parsed.version || 1,
            currentPacketId: parsed.currentPacketId,
            lastActivityAt: parsed.lastActivityAt,
            packets: parsed.packets || {},
            snapshots: parsed.snapshots || {}
        };
    } catch (error) {
        return {
            version: 1,
            packets: {},
            snapshots: {}
        };
    }
}

function ensureDirectory(dirPath: string) {
    fs.mkdirSync(dirPath, {recursive: true});
}

function fail(message: string): never {
    console.error(message);
    process.exit(1);
}

function hasFlag(args: string[], flag: string): boolean {
    return args.indexOf(flag) >= 0;
}

function extractOption(args: string[], option: string): string {
    const index = args.indexOf(option);
    if (index < 0) {
        return undefined;
    }

    const value = args[index + 1];
    if (!value) {
        throw new Error(`Missing value for ${option}`);
    }

    args.splice(index, 2);
    return value;
}

function firstPositional(args: string[]): string {
    return positionalArgs(args)[0];
}

function positionalArgs(args: string[]): string[] {
    const values: string[] = [];
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === '--all') {
            continue;
        }
        if (arg === '--history-dir') {
            index++;
            continue;
        }
        values.push(arg);
    }
    return values;
}

main();

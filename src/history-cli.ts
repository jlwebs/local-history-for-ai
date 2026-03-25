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
}

interface IContext {
    cwd: string;
    workspaceRoot: string;
    historyRoot: string;
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
  log|lg <file>                   List snapshots for a file
  show|sh <file> [rev]            Print a snapshot to stdout
  diff|di <file> [rev] [rev2]     Diff current vs rev, or rev vs rev2
  restore|rs <file> [rev]         Restore a snapshot into the working file

Options:
  --history-dir <path>            Override the .history directory root

Revision syntax:
  Use numeric indexes from 'log'. 0 is the latest snapshot.`);
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

    const revisions = getRevisionsForFile(context, fileArg);
    if (!revisions.length) {
        console.log('No snapshots found.');
        return;
    }

    revisions.forEach(revision => {
        console.log(`${revision.index}  ${formatRelativeAge(revision.date)}  ${formatLocalDate(revision.date)}  ${revision.relativeFile}`);
    });
}

function runShow(context: IContext, args: string[]) {
    const fileArg = firstPositional(args);
    if (!fileArg) {
        throw new Error('show requires a file path.');
    }

    const positional = positionalArgs(args);
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

    return {
        index: -1,
        revisionPath,
        timestamp,
        date: parseTimestamp(timestamp),
        workspaceFile: path.join(context.workspaceRoot, relativeFile),
        relativeFile
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
    const index = Number.parseInt(revisionRef, 10);
    if (Number.isNaN(index) || index < 0 || index >= revisions.length) {
        throw new Error(`Invalid revision index: ${revisionRef}`);
    }

    return revisions[index];
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

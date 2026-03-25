import * as vscode from 'vscode';

let outputChannel: vscode.OutputChannel;

export function initLogger(context: vscode.ExtensionContext) {
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel('Vibe Local History');
        context.subscriptions.push(outputChannel);
    }

    return outputChannel;
}

export function showLogger(preserveFocus = false) {
    if (outputChannel) {
        outputChannel.show(preserveFocus);
    }
}

export function logInfo(message: string) {
    if (outputChannel) {
        outputChannel.appendLine(`[info] ${message}`);
    }
}

export function logWarn(message: string) {
    if (outputChannel) {
        outputChannel.appendLine(`[warn] ${message}`);
    }
}

export function logError(message: string) {
    if (outputChannel) {
        outputChannel.appendLine(`[error] ${message}`);
    }
}

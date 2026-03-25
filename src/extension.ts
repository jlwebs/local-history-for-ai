import * as vscode from 'vscode';

import {HistoryController}  from './history.controller';
import HistoryTreeProvider  from './historyTree.provider';
import { initLogger, logError, logInfo, showLogger } from './logger';

/**
* Activate the extension.
*/
export function activate(context: vscode.ExtensionContext) {
    initLogger(context);
    showLogger(true);
    logInfo('Welcome to Vibe Local History.');
    logInfo('This extension tracks on-disk file changes and keeps timestamped snapshots in .history.');
    logInfo('If the tree says "No history", check the active editor first. The default filter is "current file".');
    logInfo('Supported sources: editor saves, git restore-like operations, scripts, external edits, and AI tools.');
    logInfo('Activating extension...');

    try {
        const controller = new HistoryController();

        context.subscriptions.push(vscode.commands.registerTextEditorCommand('local-history.showAll', controller.showAll, controller));
        context.subscriptions.push(vscode.commands.registerTextEditorCommand('local-history.showCurrent', controller.showCurrent, controller));
        context.subscriptions.push(vscode.commands.registerTextEditorCommand('local-history.compareToActive', controller.compareToActive, controller));
        context.subscriptions.push(vscode.commands.registerTextEditorCommand('local-history.compareToCurrent', controller.compareToCurrent, controller));
        context.subscriptions.push(vscode.commands.registerTextEditorCommand('local-history.compareToPrevious', controller.compareToPrevious, controller));

        // Tree
        const treeProvider = new HistoryTreeProvider(controller);
        context.subscriptions.push(vscode.window.registerTreeDataProvider('treeLocalHistory', treeProvider));

        context.subscriptions.push(vscode.commands.registerCommand('treeLocalHistory.deleteAll', treeProvider.deleteAll, treeProvider));
        context.subscriptions.push(vscode.commands.registerCommand('treeLocalHistory.refresh', treeProvider.refresh, treeProvider));
        context.subscriptions.push(vscode.commands.registerCommand('treeLocalHistory.more', treeProvider.more, treeProvider));

        context.subscriptions.push(vscode.commands.registerCommand('treeLocalHistory.forCurrentFile', treeProvider.forCurrentFile, treeProvider));
        context.subscriptions.push(vscode.commands.registerCommand('treeLocalHistory.forAll', treeProvider.forAll, treeProvider));
        context.subscriptions.push(vscode.commands.registerCommand('treeLocalHistory.forSpecificFile', treeProvider.forSpecificFile, treeProvider));
        context.subscriptions.push(vscode.commands.registerCommand('treeLocalHistory.setRetentionDays', treeProvider.setRetentionDays, treeProvider));

        context.subscriptions.push(vscode.commands.registerCommand('treeLocalHistory.showEntry', treeProvider.show, treeProvider));
        context.subscriptions.push(vscode.commands.registerCommand('treeLocalHistory.showSideEntry', treeProvider.showSide, treeProvider));
        context.subscriptions.push(vscode.commands.registerCommand('treeLocalHistory.deleteEntry', treeProvider.delete, treeProvider));
        context.subscriptions.push(vscode.commands.registerCommand('treeLocalHistory.compareToCurrentEntry', treeProvider.compareToCurrent, treeProvider));
        context.subscriptions.push(vscode.commands.registerCommand('treeLocalHistory.selectEntry', treeProvider.select, treeProvider));
        context.subscriptions.push(vscode.commands.registerCommand('treeLocalHistory.compareEntry', treeProvider.compare, treeProvider));
        context.subscriptions.push(vscode.commands.registerCommand('treeLocalHistory.restoreEntry', treeProvider.restore, treeProvider));

        // Keep editor save hooks for unsaved buffers, but rely on file watching for external changes.
        context.subscriptions.push(vscode.workspace.onWillSaveTextDocument(
            e => e.waitUntil(controller.saveFirstRevision(e.document))
        ));

        context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(document => {
            controller.saveRevision(document)
                .then ((saveDocument) => {
                    // refresh viewer (if any)
                    if (saveDocument) {
                        treeProvider.refresh();
                    }
                });
        }));

        const watcher = vscode.workspace.createFileSystemWatcher('**/*', false, false, false);
        context.subscriptions.push(watcher);
        context.subscriptions.push(watcher.onDidCreate(uri => {
            controller.saveFileRevision(uri, 'create')
                .then(saved => saved && treeProvider.refresh());
        }));
        context.subscriptions.push(watcher.onDidChange(uri => {
            controller.saveFileRevision(uri, 'change')
                .then(saved => saved && treeProvider.refresh());
        }));
        context.subscriptions.push(watcher.onDidDelete(uri => {
            controller.handleDeletion(uri)
                .then(changed => changed && treeProvider.refresh());
        }));

        context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(
            e => treeProvider.changeActiveFile()
        ));

        context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(configChangedEvent => {
            if ( configChangedEvent.affectsConfiguration('local-history.treeLocation') )
                treeProvider.initLocation();

            else if ( configChangedEvent.affectsConfiguration('local-history') ) {
                controller.clearSettings();
                treeProvider.refresh();
            }
        }));

        logInfo('Extension activated successfully.');
    } catch (error) {
        const message = error instanceof Error ? error.stack || error.message : String(error);
        logError('Activation failed.');
        logError(message);
        showLogger(true);
        vscode.window.showErrorMessage(`Vibe Local History failed to activate. See output channel for details.`);
        throw error;
    }
}

// function deactivate() {
// }

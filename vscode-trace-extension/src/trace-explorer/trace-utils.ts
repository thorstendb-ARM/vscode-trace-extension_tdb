import * as vscode from 'vscode';
import * as path from 'path';
import { Trace as TspTrace } from 'tsp-typescript-client/lib/models/trace';
import { TraceViewerPanel } from '../trace-viewer-panel/trace-viewer-webview-panel';
import {
    getExperimentManager,
    getTraceManager,
    getTspClient,
    updateNoExperimentsContext
} from '../utils/backend-tsp-client-provider';
import { messenger, traceLogger } from '../extension';
import { KeyboardShortcutsPanel } from '../trace-viewer-panel/keyboard-shortcuts-panel';
import { ConfigurationQuery, Experiment } from 'tsp-typescript-client';

const LAST_OPEN_PATH_KEY = 'traceExplorer.lastOpenPath';
const XML_ANALYSIS_SOURCE_TYPE_ID = 'org.eclipse.tracecompass.tmf.core.config.xmlsourcetype';

export type OpenDialogMode = 'File' | 'Folder' | 'XML';
export type ClearTraceServerScope = 'all' | 'experiments' | 'configurations';

type ClearTraceServerQuickPickItem = vscode.QuickPickItem & { scope: ClearTraceServerScope };

const CLEAR_TRACE_SERVER_ITEMS: ClearTraceServerQuickPickItem[] = [
    {
        label: 'All Experiments and Configurations',
        description: 'Remove all experiments, traces, and XML configurations from the trace server',
        scope: 'all'
    },
    {
        label: 'Experiments',
        description: 'Remove all experiments and traces from the trace server',
        scope: 'experiments'
    },
    {
        label: 'Configurations',
        description: 'Remove all XML analysis configurations from the trace server',
        scope: 'configurations'
    }
];

// eslint-disable-next-line no-shadow
export enum ProgressMessages {
    COMPLETE = 'Complete',
    MERGING_TRACES = 'Merging trace(s)',
    FINDING_TRACES = 'Finding trace(s)',
    OPENING_TRACES = 'Opening trace(s)',
    ROLLING_BACK_TRACES = 'Rolling back trace(s)'
}

export const openOverviewHandler = () => (): void => {
    TraceViewerPanel.showOverviewToCurrent();
};

export const resetZoomHandler = () => (): void => {
    TraceViewerPanel.resetZoomOnCurrent();
};

export const keyboardShortcutsHandler = (extensionUri: vscode.Uri): void => {
    KeyboardShortcutsPanel.createOrShow(extensionUri, 'Trace Viewer Shortcuts');
};

export const undoRedoHandler = (undo: boolean): void => {
    TraceViewerPanel.undoRedoOnCurrent(undo);
};

export const zoomHandler = (hasZoomedIn: boolean): void => {
    TraceViewerPanel.zoomOnCurrent(hasZoomedIn);
};

/**
 * Show an open dialog for traces or XML analyses.
 *
 * Remembers the last selected location in `globalState` and uses it as `defaultUri`
 * the next time the dialog is opened.
 */
export const openDialog = async (
    mode: OpenDialogMode,
    context: vscode.ExtensionContext
): Promise<vscode.Uri | undefined> => {
    const isFile = mode !== 'Folder';
    const titles: Record<OpenDialogMode, string> = {
        File: 'Open Trace File',
        Folder: 'Open Trace Folder',
        XML: 'Open XML Analysis'
    };
    const props: vscode.OpenDialogOptions = {
        title: titles[mode],
        canSelectFiles: isFile,
        canSelectFolders: !isFile,
        canSelectMany: false,
        defaultUri: getLastOpenUri(context),
        ...(mode === 'XML' ? { filters: { 'XML files': ['xml'] } } : {})
    };
    const selection = await vscode.window.showOpenDialog(props);
    const uri = selection?.[0];
    if (!uri) {
        return undefined;
    }
    await updateLastOpenPath(context, uri, isFile);
    return uri;
};

export const xmlAnalysisHandler =
    () =>
    async (xmlUri: vscode.Uri): Promise<boolean> => {
        const filePath = xmlUri.fsPath;
        if (!filePath) {
            traceLogger.showError('Cannot load XML analysis: could not retrieve path from URI for ' + xmlUri);
            return false;
        }

        const fileName = path.basename(filePath);
        const name = path.basename(filePath, path.extname(filePath));
        const response = await getTspClient().createConfiguration(
            XML_ANALYSIS_SOURCE_TYPE_ID,
            new ConfigurationQuery(name, `XML data-driven analysis: ${fileName}`, { path: filePath })
        );

        if (!response.isOk()) {
            traceLogger.showError(
                `Failed to load XML analysis (${response.getStatusCode()}): ${response.getStatusMessage()}`
            );
            return false;
        }

        vscode.window.showInformationMessage(
            `Loaded XML analysis: ${fileName}. Open traces after loading XML for the analysis to be available.`
        );
        return true;
    };

export const fileHandler =
    () =>
    async (context: vscode.ExtensionContext, traceUri: vscode.Uri): Promise<Experiment | undefined> => {
        const resolvedTraceURI: vscode.Uri = traceUri;
        const { traceManager, experimentManager } = getManagers();
        return vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: getProgressBarTitle(resolvedTraceURI),
                cancellable: true
            },
            async (progress, token) => {
                try {
                    if (token.isCancellationRequested) {
                        progress.report({ message: ProgressMessages.COMPLETE, increment: 100 });
                        return undefined;
                    }

                    const filePath: string = resolvedTraceURI.fsPath;
                    if (!filePath) {
                        traceLogger.showError(
                            'Cannot open trace: could not retrieve path from URI for trace ' + resolvedTraceURI
                        );
                        return undefined;
                    }

                    const name = path.basename(filePath);
                    progress.report({ message: ProgressMessages.FINDING_TRACES, increment: 10 });
                    /*
                     * TODO: use backend service to find traces
                     */
                    const tracesArray: string[] = [];
                    const fileStat = await vscode.workspace.fs.stat(resolvedTraceURI);
                    if (fileStat) {
                        if (fileStat.type === vscode.FileType.Directory) {
                            // Find recursively CTF traces
                            const foundTraces = await findTraces(filePath);

                            // No CTF traces found. Add root directory as trace directory.
                            // Back-end will reject if it is not a trace
                            if (foundTraces.length === 0) {
                                foundTraces.push(filePath);
                            }
                            foundTraces.forEach(trace => tracesArray.push(trace));
                        } else {
                            // Open single trace file
                            tracesArray.push(filePath);
                        }
                    }

                    if (tracesArray.length === 0) {
                        progress.report({ message: ProgressMessages.COMPLETE, increment: 100 });
                        traceLogger.showError('No valid traces found in the selected directory: ' + resolvedTraceURI);
                        return;
                    }

                    progress.report({ message: ProgressMessages.OPENING_TRACES, increment: 20 });
                    const traces = new Array<TspTrace>();
                    for (let i = 0; i < tracesArray.length; i++) {
                        const traceName = path.basename(tracesArray[i]);
                        const trace = await traceManager.openTrace(tracesArray[i], traceName);
                        if (trace) {
                            traces.push(trace);
                        } else {
                            traceLogger.showError(
                                'Failed to open trace: ' +
                                    traceName +
                                    '. There may be an issue with the server or the trace is invalid.'
                            );
                        }
                    }

                    if (token.isCancellationRequested) {
                        rollbackTraces(traces, 20, progress);
                        progress.report({ message: ProgressMessages.COMPLETE, increment: 50 });
                        return;
                    }

                    progress.report({ message: ProgressMessages.MERGING_TRACES, increment: 40 });
                    if (traces === undefined || traces.length === 0) {
                        progress.report({ message: ProgressMessages.COMPLETE, increment: 30 });
                        return;
                    }

                    const experiment = await experimentManager.openExperiment(name, traces);
                    const panel = TraceViewerPanel.createOrShow(
                        context.extensionUri,
                        experiment?.name ?? name,
                        undefined,
                        messenger
                    );
                    if (experiment) {
                        panel.setExperiment(experiment);
                    }

                    if (token.isCancellationRequested) {
                        if (experiment) {
                            experimentManager.deleteExperiment(experiment.UUID);
                        }
                        rollbackTraces(traces, 20, progress);
                        progress.report({ message: ProgressMessages.COMPLETE, increment: 10 });
                        panel.dispose();
                        return undefined;
                    }
                    progress.report({ message: ProgressMessages.COMPLETE, increment: 30 });
                    return experiment;
                } finally {
                    updateNoExperimentsContext();
                }
            }
        );
    };

export const deleteExperiment = async (
    extensionUri: vscode.Uri,
    uuid: string,
    experiment?: Experiment
): Promise<void> => {
    // dispose any open panels associated with the experiment
    for (const key of Object.keys(TraceViewerPanel.activePanels)) {
        const panel = TraceViewerPanel.activePanels[key];
        const experimentUuid = panel?.getExperiment()?.UUID;
        if (experimentUuid === uuid) {
            TraceViewerPanel.disposePanel(extensionUri, key);
        }
    }
    // remove experiment from the experiment manager
    const experimentManager = getManagers().experimentManager;
    // ExperimentManager.deleteExperiment is a no-op if the experiment is not in its internal
    // map (e.g. after a reload, or when triggered for an experiment fetched directly via tspClient).
    // Re-register it first so the manager actually issues the delete and emits EXPERIMENT_DELETED.
    const experimentToDelete = experiment ?? (await experimentManager.getExperiment(uuid));
    if (experimentToDelete) {
        experimentManager.addExperiment(experimentToDelete);
    }
    await experimentManager.deleteExperiment(uuid);
};

/**
 * Prompt the user to pick a clear scope, confirm, and run {@link clearTraceServer} with progress UI.
 */
export const promptAndClearTraceServer = async (extensionUri: vscode.Uri): Promise<boolean> => {
    const selection = await vscode.window.showQuickPick(CLEAR_TRACE_SERVER_ITEMS, { title: 'Clear Trace Server' });
    if (!selection) {
        return false;
    }

    const confirmed = await vscode.window.showWarningMessage(
        `Remove ${selection.label.toLowerCase()} from the trace server?`,
        { modal: true },
        selection.label
    );
    if (confirmed !== selection.label) {
        return false;
    }

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `Clear Trace Server: ${selection.label}`,
            cancellable: false
        },
        () => clearTraceServer(extensionUri, selection.scope)
    );
    return true;
};

export const clearTraceServer = async (extensionUri: vscode.Uri, scope: ClearTraceServerScope): Promise<void> => {
    if (scope === 'all' || scope === 'experiments') {
        await deleteAllExperimentsAndTraces(extensionUri);
    }
    if (scope === 'all' || scope === 'configurations') {
        await deleteAllXmlConfigurations();
    }
    await updateNoExperimentsContext();
};

async function deleteAllExperimentsAndTraces(extensionUri: vscode.Uri): Promise<void> {
    for (const key of Object.keys(TraceViewerPanel.activePanels)) {
        TraceViewerPanel.disposePanel(extensionUri, key);
    }

    const tspClient = getTspClient();

    const experimentsResponse = await tspClient.fetchExperiments();
    if (!experimentsResponse.isOk()) {
        traceLogger.showError(
            `Failed to fetch experiments (${experimentsResponse.getStatusCode()}): ${experimentsResponse.getStatusMessage()}`
        );
    } else {
        const experiments = experimentsResponse.getModel() ?? [];
        for (const experiment of experiments) {
            await deleteExperimentFromServer(tspClient, experiment);
        }
    }

    const tracesResponse = await tspClient.fetchTraces();
    if (!tracesResponse.isOk()) {
        traceLogger.showError(
            `Failed to fetch traces (${tracesResponse.getStatusCode()}): ${tracesResponse.getStatusMessage()}`
        );
    } else {
        const traces = tracesResponse.getModel() ?? [];
        for (const trace of traces) {
            await deleteTraceFromServer(tspClient, trace);
        }
    }
}

async function deleteExperimentFromServer(
    tspClient: ReturnType<typeof getTspClient>,
    experiment: Experiment
): Promise<void> {
    const deleteResponse = await tspClient.deleteExperiment(experiment.UUID);
    if (!deleteResponse.isOk() && deleteResponse.getStatusCode() !== 404) {
        traceLogger.showError(
            `Failed to delete experiment ${experiment.name} (${deleteResponse.getStatusCode()}): ${deleteResponse.getStatusMessage()}`
        );
    }
}

async function deleteTraceFromServer(
    tspClient: ReturnType<typeof getTspClient>,
    trace: TspTrace
): Promise<void> {
    const deleteResponse = await tspClient.deleteTrace(trace.UUID);
    if (!deleteResponse.isOk() && deleteResponse.getStatusCode() !== 404) {
        traceLogger.showError(
            `Failed to delete trace ${trace.name} (${deleteResponse.getStatusCode()}): ${deleteResponse.getStatusMessage()}`
        );
    }
}

async function deleteAllXmlConfigurations(): Promise<void> {
    const tspClient = getTspClient();
    const response = await tspClient.fetchConfigurations(XML_ANALYSIS_SOURCE_TYPE_ID);
    if (!response.isOk()) {
        if (response.getStatusCode() !== 404) {
            traceLogger.showError(
                `Failed to fetch XML analyses (${response.getStatusCode()}): ${response.getStatusMessage()}`
            );
        }
        return;
    }
    const configurations = response.getModel() ?? [];
    await Promise.all(
        configurations.map(async ({ id }) => {
            const deleteResponse = await tspClient.deleteConfiguration(XML_ANALYSIS_SOURCE_TYPE_ID, id);
            if (!deleteResponse.isOk() && deleteResponse.getStatusCode() !== 404) {
                traceLogger.showError(
                    `Failed to delete XML analysis ${id} (${deleteResponse.getStatusCode()}): ${deleteResponse.getStatusMessage()}`
                );
            }
        })
    );
}

function getLastOpenUri(context: vscode.ExtensionContext): vscode.Uri | undefined {
    const lastPath = context.globalState.get<string>(LAST_OPEN_PATH_KEY);
    return lastPath ? vscode.Uri.file(lastPath) : undefined;
}

async function updateLastOpenPath(
    context: vscode.ExtensionContext,
    uri: vscode.Uri,
    selectedFile: boolean
): Promise<void> {
    if (!uri.fsPath) {
        return;
    }
    await context.globalState.update(LAST_OPEN_PATH_KEY, selectedFile ? path.dirname(uri.fsPath) : uri.fsPath);
}

const rollbackTraces = async (
    traces: Array<TspTrace>,
    progressIncrement: number,
    progress: vscode.Progress<{
        message: string | undefined;
        increment: number | undefined;
    }>
) => {
    const { traceManager } = getManagers();
    progress.report({ message: ProgressMessages.ROLLING_BACK_TRACES, increment: progressIncrement });
    for (let i = 0; i < traces.length; i++) {
        await traceManager.deleteTrace(traces[i].UUID);
    }
};

/*
 * TODO: Make a proper trace finder, not just CTF
 */
const findTraces = async (directory: string): Promise<string[]> => {
    const traces: string[] = [];
    const uri = vscode.Uri.file(directory);
    /**
     * If single file selection then return single trace in traces, if directory then find
     * recursively CTF traces in starting from root directory.
     */
    const ctf = await isCtf(directory);
    if (ctf) {
        traces.push(directory);
    } else {
        // Look at the sub-directories of this
        await vscode.workspace.fs.stat(uri);
        const childrenArr = await vscode.workspace.fs.readDirectory(uri);
        for (const child of childrenArr) {
            if (child[1] === vscode.FileType.Directory) {
                const subTraces = await findTraces(path.join(directory, child[0]));
                subTraces.forEach(trace => traces.push(trace));
            }
        }
    }
    return traces;
};

const isCtf = async (directory: string): Promise<boolean> => {
    const uri = vscode.Uri.file(directory);
    const childrenArr = await vscode.workspace.fs.readDirectory(uri);
    for (const child of childrenArr) {
        if (child[0] === 'metadata') {
            return true;
        }
    }
    return false;
};

function getProgressBarTitle(traceUri: vscode.Uri | undefined): string {
    if (!traceUri || !traceUri.fsPath) {
        return 'undefined';
    }
    return path.basename(traceUri.fsPath);
}

function getManagers() {
    return {
        traceManager: getTraceManager(),
        experimentManager: getExperimentManager()
    };
}

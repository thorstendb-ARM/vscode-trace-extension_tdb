import * as vscode from 'vscode';
import * as path from 'path';
import { Trace as TspTrace } from 'tsp-typescript-client/lib/models/trace';
import { RestClient } from 'tsp-typescript-client/lib/protocol/rest-client';
import { signalManager } from 'traceviewer-base/lib/signals/signal-manager';
import { XmlViewDisplayMode, XmlViewMetadata, XmlViewRole } from 'traceviewer-base/lib/signals/xml-view-metadata';
import { TraceViewerPanel } from '../trace-viewer-panel/trace-viewer-webview-panel';
import { getExperimentManager, getTraceManager, getTspClient } from '../utils/backend-tsp-client-provider';
import { ClientType, getTspClientUrl, updateNoExperimentsContext } from '../utils/backend-tsp-client-provider';
import { messenger, traceLogger } from '../extension';
import { KeyboardShortcutsPanel } from '../trace-viewer-panel/keyboard-shortcuts-panel';
import { Experiment } from 'tsp-typescript-client';
import { Query } from 'tsp-typescript-client/lib/models/query/query';

const XML_ANALYSIS_SOURCE_TYPE_ID = 'org.eclipse.tracecompass.tmf.core.config.xmlsourcetype';
const LAST_OPEN_PATH_KEY = 'traceExplorer.lastOpenPath';
const XML_VIEW_METADATA_KEY = 'traceExplorer.xmlViewMetadata';
const XML_VIEW_METADATA_COMMENT = /<!--\s*trace-viewer:(?:xy-view|view)\s+([\s\S]*?)-->/g;
const XML_VIEW_METADATA_ATTRIBUTE = /([A-Za-z_][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

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

export const openDialog = async (
    context: vscode.ExtensionContext,
    selectFiles = false
): Promise<vscode.Uri | undefined> => {
    const props: vscode.OpenDialogOptions = {
        title: selectFiles ? 'Open Trace File' : 'Open Trace Folder',
        canSelectFolders: !selectFiles,
        canSelectFiles: selectFiles,
        canSelectMany: false,
        defaultUri: getLastOpenPath(context)
    };
    let traceURI = undefined;
    traceURI = await vscode.window.showOpenDialog(props);
    if (traceURI && traceURI[0]) {
        await rememberOpenPath(context, traceURI[0], selectFiles);
        return traceURI[0];
    }
    return undefined;
};

export const openXmlAnalysisDialog = async (context: vscode.ExtensionContext): Promise<vscode.Uri | undefined> => {
    const result = await vscode.window.showOpenDialog({
        title: 'Open XML Analysis File',
        canSelectFolders: false,
        canSelectFiles: true,
        canSelectMany: false,
        defaultUri: getLastOpenPath(context),
        filters: {
            'XML files': ['xml']
        }
    });
    if (result?.[0]) {
        await rememberOpenPath(context, result[0], true);
    }
    return result?.[0];
};

function getLastOpenPath(context: vscode.ExtensionContext): vscode.Uri | undefined {
    const lastPath = context.globalState.get<string>(LAST_OPEN_PATH_KEY);
    return lastPath ? vscode.Uri.file(lastPath) : undefined;
}

async function rememberOpenPath(
    context: vscode.ExtensionContext,
    selectedUri: vscode.Uri,
    selectedFile: boolean
): Promise<void> {
    const selectedPath = selectedUri.fsPath;
    if (!selectedPath) {
        return;
    }
    const directory = selectedFile ? path.dirname(selectedPath) : selectedPath;
    await context.globalState.update(LAST_OPEN_PATH_KEY, directory);
}

export const xmlAnalysisHandler = (context: vscode.ExtensionContext) => async (xmlUri: vscode.Uri): Promise<boolean> => {
    const filePath = xmlUri.fsPath;
    if (!filePath) {
        traceLogger.showError('Cannot load XML analysis: could not retrieve path from URI for ' + xmlUri);
        return false;
    }

    const name = path.basename(filePath, path.extname(filePath));
    const url = `${getTspClientUrl(ClientType.BACKEND)}/config/types/${XML_ANALYSIS_SOURCE_TYPE_ID}/configs`;
    const response = await RestClient.post(url, {
        name,
        description: `XML data-driven analysis: ${name}`,
        parameters: {
            path: filePath
        }
    });

    if (!response.isOk()) {
        const error = response.getErrorResponse()?.title ?? response.getStatusMessage();
        traceLogger.showError(`Failed to load XML analysis: ${error}`);
        return false;
    }

    const xmlViewMetadata = await readXmlViewMetadata(xmlUri);
    try {
        await refreshExperimentsAfterXmlAnalysisLoad();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        traceLogger.showError(`Loaded XML analysis, but failed to refresh open experiments: ${message}`);
        return false;
    }
    await storeXmlViewMetadata(context, xmlViewMetadata);
    signalManager().emit('XML_VIEW_METADATA_UPDATED', { views: xmlViewMetadata });
    vscode.window.showInformationMessage(`Loaded XML analysis: ${path.basename(filePath)}`);
    return true;
};

export function getStoredXmlViewMetadata(context: vscode.ExtensionContext): XmlViewMetadata[] {
    const stored = context.globalState.get<XmlViewMetadata[]>(XML_VIEW_METADATA_KEY);
    return Array.isArray(stored) ? stored : [];
}

export async function loadXmlViewMetadata(context: vscode.ExtensionContext): Promise<XmlViewMetadata[]> {
    const stored = getStoredXmlViewMetadata(context);
    if (stored.length > 0 && stored.some(metadata => metadata.stateValues !== undefined)) {
        return stored;
    }

    const restored = await restoreXmlViewMetadataFromServerConfigurations(context);
    if (restored.length > 0) {
        await storeXmlViewMetadata(context, restored);
        return restored;
    }
    return stored;
}

async function storeXmlViewMetadata(
    context: vscode.ExtensionContext,
    xmlViewMetadata: XmlViewMetadata[]
): Promise<void> {
    await context.globalState.update(XML_VIEW_METADATA_KEY, xmlViewMetadata);
}

async function clearStoredXmlViewMetadata(context: vscode.ExtensionContext): Promise<void> {
    await context.globalState.update(XML_VIEW_METADATA_KEY, undefined);
}

async function restoreXmlViewMetadataFromServerConfigurations(
    context: vscode.ExtensionContext
): Promise<XmlViewMetadata[]> {
    const lastPath = context.globalState.get<string>(LAST_OPEN_PATH_KEY);
    if (!lastPath) {
        return [];
    }

    let configs: Array<{ id?: string; name?: string }> = [];
    try {
        const tspClient = getTspClient();
        const configsResponse = await tspClient.fetchConfigurations(XML_ANALYSIS_SOURCE_TYPE_ID);
        if (!configsResponse.isOk()) {
            return [];
        }
        configs = (configsResponse.getModel() ?? []) as Array<{ id?: string; name?: string }>;
    } catch {
        return [];
    }

    const views: XmlViewMetadata[] = [];
    for (const config of configs) {
        const xmlUri = await findXmlAnalysisFileForConfig(lastPath, config);
        if (!xmlUri) {
            continue;
        }
        views.push(...(await tryReadXmlViewMetadata(xmlUri)));
    }
    return views;
}

async function findXmlAnalysisFileForConfig(
    lastPath: string,
    config: { id?: string; name?: string }
): Promise<vscode.Uri | undefined> {
    const candidateNames = new Set<string>();
    [config.id, config.name].forEach(value => {
        if (!value) {
            return;
        }
        candidateNames.add(value);
        if (!value.endsWith('.xml')) {
            candidateNames.add(value + '.xml');
        }
    });

    for (const candidateName of candidateNames) {
        const candidate = vscode.Uri.file(path.join(lastPath, candidateName));
        if (await fileExists(candidate)) {
            return candidate;
        }
    }
    return undefined;
}

async function tryReadXmlViewMetadata(xmlUri: vscode.Uri): Promise<XmlViewMetadata[]> {
    try {
        const content = Buffer.from(await vscode.workspace.fs.readFile(xmlUri)).toString('utf8');
        return parseXmlViewMetadata(content);
    } catch {
        return [];
    }
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
    try {
        const stat = await vscode.workspace.fs.stat(uri);
        return stat.type === vscode.FileType.File;
    } catch {
        return false;
    }
}

async function refreshExperimentsAfterXmlAnalysisLoad(): Promise<void> {
    const { experimentManager } = getManagers();
    const tspClient = getTspClient();
    const experimentsResponse = await tspClient.fetchExperiments();
    if (!experimentsResponse.isOk()) {
        throw new Error(`Failed to fetch experiments: ${experimentsResponse.getStatusMessage()}`);
    }

    const experiments = experimentsResponse.getModel() ?? [];
    const currentExperimentUuid = TraceViewerPanel.getCurrentExperiment()?.UUID;
    for (const experiment of experiments) {
        const traceUUIDs = experiment.traces.map(trace => trace.UUID).filter(uuid => !!uuid);
        if (!traceUUIDs.length) {
            continue;
        }

        const deleteResponse = await tspClient.deleteExperiment(experiment.UUID);
        if (!deleteResponse.isOk()) {
            throw new Error(`Failed to delete experiment ${experiment.name}: ${deleteResponse.getStatusMessage()}`);
        }

        const createResponse = await tspClient.createExperiment(
            new Query({
                name: experiment.name,
                traces: traceUUIDs
            })
        );
        const refreshedExperiment = createResponse.getModel();
        if (!createResponse.isOk() || !refreshedExperiment) {
            throw new Error(`Failed to recreate experiment ${experiment.name}: ${createResponse.getStatusMessage()}`);
        }

        experimentManager.addExperiment(refreshedExperiment);
        const panel = TraceViewerPanel.getExistingPanel(experiment.name);
        if (panel) {
            panel.setExperiment(refreshedExperiment);
        } else {
            signalManager().emit('EXPERIMENT_OPENED', refreshedExperiment);
        }

        if (currentExperimentUuid === experiment.UUID || currentExperimentUuid === refreshedExperiment.UUID) {
            signalManager().emit('EXPERIMENT_SELECTED', refreshedExperiment);
        }
    }
}

async function readXmlViewMetadata(xmlUri: vscode.Uri): Promise<XmlViewMetadata[]> {
    try {
        const content = Buffer.from(await vscode.workspace.fs.readFile(xmlUri)).toString('utf8');
        return parseXmlViewMetadata(content);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        traceLogger.showError(`Loaded XML analysis, but failed to read view metadata: ${message}`);
        return [];
    }
}

export function parseXmlViewMetadata(xmlContent: string): XmlViewMetadata[] {
    const metadata: XmlViewMetadata[] = [];
    XML_VIEW_METADATA_COMMENT.lastIndex = 0;
    let comment: RegExpExecArray | null = XML_VIEW_METADATA_COMMENT.exec(xmlContent);
    while (comment) {
        const attributes = parseXmlViewMetadataAttributes(comment[1]);
        const id = attributes.get('id');
        const group = attributes.get('group');
        if (!id || !group) {
            comment = XML_VIEW_METADATA_COMMENT.exec(xmlContent);
            continue;
        }
        const role = parseXmlViewRole(attributes.get('role'));
        const displayMode = parseXmlViewDisplayMode(attributes.get('displayMode'));
        metadata.push({
            id,
            group,
            role,
            displayMode,
            label: attributes.get('label'),
            stateValues: parseXmlViewDefinedValues(xmlContent, id)
        });
        comment = XML_VIEW_METADATA_COMMENT.exec(xmlContent);
    }
    return metadata;
}

function parseXmlViewDefinedValues(xmlContent: string, id: string): XmlViewMetadata['stateValues'] {
    const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const viewPattern = new RegExp(`<timeGraphView\\b[^>]*\\bid=["']${escapedId}["'][^>]*>([\\s\\S]*?)<\\/timeGraphView>`);
    const view = viewPattern.exec(xmlContent);
    if (!view) {
        return undefined;
    }

    const stateValues: NonNullable<XmlViewMetadata['stateValues']> = [];
    const definedValuePattern = /<definedValue\b([^>]*)\/?>/g;
    let definedValue: RegExpExecArray | null = definedValuePattern.exec(view[1]);
    while (definedValue) {
        const attributes = parseXmlViewMetadataAttributes(definedValue[1]);
        const value = attributes.get('value');
        const label = attributes.get('name');
        if (value !== undefined && label) {
            stateValues.push({
                value,
                label,
                color: attributes.get('color')
            });
        }
        definedValue = definedValuePattern.exec(view[1]);
    }

    return stateValues.length > 0 ? stateValues : undefined;
}

function parseXmlViewMetadataAttributes(content: string): Map<string, string> {
    const attributes = new Map<string, string>();
    XML_VIEW_METADATA_ATTRIBUTE.lastIndex = 0;
    let match: RegExpExecArray | null = XML_VIEW_METADATA_ATTRIBUTE.exec(content);
    while (match) {
        attributes.set(match[1], match[2] ?? match[3] ?? '');
        match = XML_VIEW_METADATA_ATTRIBUTE.exec(content);
    }
    return attributes;
}

function parseXmlViewRole(value: string | undefined): XmlViewRole | undefined {
    return value === 'lanes' || value === 'all' || value === 'signal' ? value : undefined;
}

function parseXmlViewDisplayMode(value: string | undefined): XmlViewDisplayMode | undefined {
    return value === 'stacked' || value === 'classic' ? value : undefined;
}

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

export const deleteExperiment = async (extensionUri: vscode.Uri, uuid: string) => {
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
    experimentManager.deleteExperiment(uuid);
};

export const deleteAllTracesAndXmlConfigurations = async (context: vscode.ExtensionContext): Promise<void> => {
    const extensionUri = context.extensionUri;
    const { traceManager, experimentManager } = getManagers();
    const tspClient = getTspClient();

    for (const key of Object.keys(TraceViewerPanel.activePanels)) {
        TraceViewerPanel.disposePanel(extensionUri, key);
    }
    signalManager().emit('EXPERIMENT_SELECTED', undefined);

    const experimentsResponse = await tspClient.fetchExperiments();
    if (!experimentsResponse.isOk()) {
        throw new Error(`Failed to fetch experiments: ${experimentsResponse.getStatusMessage()}`);
    }
    const experiments = experimentsResponse.getModel() ?? [];
    for (const experiment of experiments) {
        experimentManager.addExperiment(experiment);
        await experimentManager.deleteExperiment(experiment.UUID);
    }

    const tracesResponse = await tspClient.fetchTraces();
    if (!tracesResponse.isOk()) {
        throw new Error(`Failed to fetch traces: ${tracesResponse.getStatusMessage()}`);
    }
    const traces = tracesResponse.getModel() ?? [];
    for (const trace of traces) {
        traceManager.addTrace(trace);
        await traceManager.deleteTrace(trace.UUID);
    }

    const configsResponse = await tspClient.fetchConfigurations(XML_ANALYSIS_SOURCE_TYPE_ID);
    if (configsResponse.isOk()) {
        const configs = configsResponse.getModel() ?? [];
        for (const config of configs) {
            const response = await tspClient.deleteConfiguration(XML_ANALYSIS_SOURCE_TYPE_ID, config.id);
            if (!response.isOk()) {
                throw new Error(
                    `Failed to delete XML analysis configuration ${config.name}: ${response.getStatusMessage()}`
                );
            }
        }
    } else if (configsResponse.getStatusCode() !== 404) {
        throw new Error(`Failed to fetch XML analysis configurations: ${configsResponse.getStatusMessage()}`);
    }

    await clearStoredXmlViewMetadata(context);
    signalManager().emit('XML_VIEW_METADATA_UPDATED', { views: [] });
    await updateNoExperimentsContext();
};

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

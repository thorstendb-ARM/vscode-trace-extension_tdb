import { OutputDescriptor } from 'tsp-typescript-client/lib/models/output-descriptor';
import { XmlViewMetadata } from 'traceviewer-base/lib/signals/xml-view-metadata';

export interface AvailableViewEntry {
    id: string;
    name: string;
    description?: string;
    parentId?: string;
    output?: OutputDescriptor;
}

export interface CreateAvailableViewEntriesOptions {
    xmlViewMetadata?: XmlViewMetadata[];
}

export interface XmlConfiguredOutputDescriptor extends OutputDescriptor {
    traceViewerXmlViewMetadata?: XmlViewMetadata;
}

const SYNTHETIC_GROUP_ID_PREFIX = '__available_view_group__:';

function splitOutputName(name: string): { group: string; label: string } | undefined {
    const separator = ': ';
    const separatorIndex = name.indexOf(separator);
    if (separatorIndex <= 0) {
        return undefined;
    }
    const group = name.substring(0, separatorIndex).trim();
    const label = name.substring(separatorIndex + separator.length).trim();
    if (!group || !label) {
        return undefined;
    }
    return { group, label };
}

function getMetadataLabel(output: OutputDescriptor, metadata: XmlViewMetadata): string {
    if (metadata.label) {
        return metadata.label;
    }
    return splitOutputName(output.name)?.label ?? output.name;
}

function getMetadataOutput(
    output: OutputDescriptor | undefined,
    metadata: XmlViewMetadata | undefined
): OutputDescriptor | undefined {
    if (!output || !metadata) {
        return output;
    }
    return {
        ...output,
        traceViewerXmlViewMetadata: metadata
    } as XmlConfiguredOutputDescriptor;
}

export function createAvailableViewEntries(
    outputs: OutputDescriptor[],
    options: CreateAvailableViewEntriesOptions = {}
): AvailableViewEntry[] {
    const entries: AvailableViewEntry[] = [];
    const outputIds = new Set(outputs.map(output => output.id));
    const outputById = new Map(outputs.map(output => [output.id, output]));
    const xmlViewMetadata = options.xmlViewMetadata ?? [];
    const metadataByOutputId = new Map(xmlViewMetadata.map(metadata => [metadata.id, metadata]));
    const explicitXmlSignalGroups = new Map<string, XmlViewMetadata[]>();
    xmlViewMetadata.forEach(metadata => {
        if (!outputById.has(metadata.id)) {
            return;
        }
        const groupMetadata = explicitXmlSignalGroups.get(metadata.group) ?? [];
        groupMetadata.push(metadata);
        explicitXmlSignalGroups.set(metadata.group, groupMetadata);
    });
    const emittedExplicitXmlSignalGroups = new Set<string>();

    const getUniqueGroupId = (group: string): string => {
        let id = SYNTHETIC_GROUP_ID_PREFIX + group;
        while (outputIds.has(id)) {
            id = SYNTHETIC_GROUP_ID_PREFIX + id;
        }
        return id;
    };

    const emitExplicitXmlSignalGroup = (group: string): void => {
        if (emittedExplicitXmlSignalGroups.has(group)) {
            return;
        }
        emittedExplicitXmlSignalGroups.add(group);

        const groupMetadata = explicitXmlSignalGroups.get(group) ?? [];
        const laneMetadata = groupMetadata.find(
            metadata => metadata.role === 'lanes' || metadata.displayMode === 'stacked'
        );
        const allSignalsMetadata = groupMetadata.find(metadata => metadata.role === 'all');
        const laneOutput = laneMetadata ? outputById.get(laneMetadata.id) : undefined;
        const allSignalsOutput = allSignalsMetadata ? outputById.get(allSignalsMetadata.id) : undefined;
        const decoratedLaneOutput = getMetadataOutput(laneOutput, laneMetadata);
        const groupEntry: AvailableViewEntry = {
            id: getUniqueGroupId(group),
            name: group,
            description: decoratedLaneOutput?.description ?? group,
            output: decoratedLaneOutput
        };
        entries.push(groupEntry);

        if (allSignalsMetadata && allSignalsOutput) {
            entries.push({
                id: allSignalsOutput.id,
                name: getMetadataLabel(allSignalsOutput, allSignalsMetadata),
                description: allSignalsOutput.description,
                parentId: groupEntry.id,
                output: getMetadataOutput(allSignalsOutput, allSignalsMetadata)
            });
        }

        groupMetadata.forEach(metadata => {
            if (metadata === laneMetadata || metadata === allSignalsMetadata || metadata.role === 'lanes') {
                return;
            }
            const output = outputById.get(metadata.id);
            if (!output) {
                return;
            }
            entries.push({
                id: output.id,
                name: getMetadataLabel(output, metadata),
                description: output.description,
                parentId: groupEntry.id,
                output: getMetadataOutput(output, metadata)
            });
        });
    };

    outputs.forEach(output => {
        const splitName = output.parentId ? undefined : splitOutputName(output.name);
        const metadata = metadataByOutputId.get(output.id);
        if (metadata && explicitXmlSignalGroups.has(metadata.group)) {
            emitExplicitXmlSignalGroup(metadata.group);
            return;
        }
        if (splitName && explicitXmlSignalGroups.has(splitName.group)) {
            return;
        }
        entries.push({
            id: output.id,
            name: output.name,
            description: output.description,
            parentId: output.parentId,
            output
        });
    });

    return entries;
}

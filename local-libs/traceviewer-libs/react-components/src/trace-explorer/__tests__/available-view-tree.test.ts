import { OutputDescriptor, ProviderType } from 'tsp-typescript-client/lib/models/output-descriptor';
import { createAvailableViewEntries } from '../available-view-tree';

const XML_ANALYSIS_SOURCE_TYPE_ID = 'org.eclipse.tracecompass.tmf.core.config.xmlsourcetype';

function output(id: string, name: string, parentId?: string, sourceTypeId?: string): OutputDescriptor {
    const descriptor: OutputDescriptor = {
        id,
        name,
        parentId,
        description: name + ' description',
        type: ProviderType.TREE_TIME_XY
    };
    if (sourceTypeId) {
        descriptor.configuration = {
            id: id + '.config',
            name: name + ' config',
            sourceTypeId
        };
    }
    return descriptor;
}

function xmlOutput(id: string, name: string, parentId?: string): OutputDescriptor {
    return output(id, name, parentId, XML_ANALYSIS_SOURCE_TYPE_ID);
}

describe('createAvailableViewEntries', () => {
    test('keeps flat descriptors unchanged when no XML signal lanes group exists', () => {
        const entries = createAvailableViewEntries([
            output('cortexm.datatrace.lanes.xy', 'Cortex-M Data Trace Signals: Signal Lanes'),
            output('cortexm.datatrace.sine.xy', 'Cortex-M Data Trace Signals: Sine int16'),
            output('org.eclipse.tracecompass.internal.tmf.core.histogram.HistogramDataProvider', 'Histogram')
        ]);

        expect(entries.map(entry => ({ name: entry.name, parentId: entry.parentId }))).toEqual([
            { name: 'Cortex-M Data Trace Signals: Signal Lanes', parentId: undefined },
            { name: 'Cortex-M Data Trace Signals: Sine int16', parentId: undefined },
            { name: 'Histogram', parentId: undefined }
        ]);
    });

    test('keeps server descriptors unchanged without XML metadata or loaded XML config', () => {
        const entries = createAvailableViewEntries([
            output('cortexm.datatrace.lanes.xy', 'Cortex-M Data Trace Signals: Signal Lanes'),
            output('cortexm.datatrace.all.xy', 'Cortex-M Data Trace Signals: All Signals'),
            output('cortexm.datatrace.sine.xy', 'Cortex-M Data Trace Signals: Sine int16'),
            output('org.eclipse.tracecompass.internal.tmf.core.histogram.HistogramDataProvider', 'Histogram')
        ]);

        expect(entries.map(entry => ({ name: entry.name, parentId: entry.parentId }))).toEqual([
            { name: 'Cortex-M Data Trace Signals: Signal Lanes', parentId: undefined },
            { name: 'Cortex-M Data Trace Signals: All Signals', parentId: undefined },
            { name: 'Cortex-M Data Trace Signals: Sine int16', parentId: undefined },
            { name: 'Histogram', parentId: undefined }
        ]);
    });

    test('builds XML signal groups from explicit XML view metadata', () => {
        const entries = createAvailableViewEntries(
            [
                output('cortexm.datatrace.lanes.xy', 'Cortex-M Data Trace Signals: Signal Lanes'),
                output('cortexm.datatrace.all.xy', 'Cortex-M Data Trace Signals: All Signals'),
                output('stale.sine.xy', 'Cortex-M Data Trace Signals: CH0 Sine int16'),
                output('cortexm.datatrace.sine.xy', 'Cortex-M Data Trace Signals: Sine int16'),
                output('org.eclipse.tracecompass.internal.tmf.core.histogram.HistogramDataProvider', 'Histogram')
            ],
            {
                xmlViewMetadata: [
                    {
                        id: 'cortexm.datatrace.lanes.xy',
                        group: 'Cortex-M Data Trace Signals',
                        role: 'lanes',
                        displayMode: 'stacked'
                    },
                    {
                        id: 'cortexm.datatrace.all.xy',
                        group: 'Cortex-M Data Trace Signals',
                        role: 'all',
                        displayMode: 'classic',
                        label: 'All Signals'
                    },
                    {
                        id: 'cortexm.datatrace.sine.xy',
                        group: 'Cortex-M Data Trace Signals',
                        role: 'signal',
                        displayMode: 'classic',
                        label: 'Sine int16'
                    }
                ]
            }
        );

        expect(entries.map(entry => ({ name: entry.name, parentId: entry.parentId }))).toEqual([
            { name: 'Cortex-M Data Trace Signals', parentId: undefined },
            { name: 'All Signals', parentId: entries[0].id },
            { name: 'Sine int16', parentId: entries[0].id },
            { name: 'Histogram', parentId: undefined }
        ]);
        expect(entries[0].output).toMatchObject({
            id: 'cortexm.datatrace.lanes.xy',
            traceViewerXmlViewMetadata: { displayMode: 'stacked' }
        });
        expect(entries.find(entry => entry.output?.id === 'stale.sine.xy')).toBeUndefined();
    });

    test('keeps old XML descriptors unchanged without explicit XML view metadata', () => {
        const entries = createAvailableViewEntries([
            xmlOutput('cortexm.datatrace.lanes.xy', 'Cortex-M Data Trace Signals: Signal Lanes'),
            xmlOutput('cortexm.datatrace.all.xy', 'Cortex-M Data Trace Signals: All Signals'),
            xmlOutput('cortexm.datatrace.sine.xy', 'Cortex-M Data Trace Signals: Sine int16'),
            xmlOutput('cortexm.datatrace.square.xy', 'Cortex-M Data Trace Signals: Square uint32'),
            output('org.eclipse.tracecompass.internal.tmf.core.histogram.HistogramDataProvider', 'Histogram')
        ]);

        expect(entries.map(entry => ({ name: entry.name, parentId: entry.parentId }))).toEqual([
            { name: 'Cortex-M Data Trace Signals: Signal Lanes', parentId: undefined },
            { name: 'Cortex-M Data Trace Signals: All Signals', parentId: undefined },
            { name: 'Cortex-M Data Trace Signals: Sine int16', parentId: undefined },
            { name: 'Cortex-M Data Trace Signals: Square uint32', parentId: undefined },
            { name: 'Histogram', parentId: undefined }
        ]);
    });

    test('hides undescribed descriptors when they share an explicitly configured XML group name', () => {
        const entries = createAvailableViewEntries(
            [
                output('server.signal.xy', 'Cortex-M Data Trace Signals: Server Signal'),
                output('cortexm.datatrace.lanes.xy', 'Cortex-M Data Trace Signals: Signal Lanes'),
                output('cortexm.datatrace.all.xy', 'Cortex-M Data Trace Signals: All Signals'),
                output('legacy.signal.xy', 'Cortex-M Data Trace Signals: Legacy Signal')
            ],
            {
                xmlViewMetadata: [
                    {
                        id: 'cortexm.datatrace.lanes.xy',
                        group: 'Cortex-M Data Trace Signals',
                        role: 'lanes',
                        displayMode: 'stacked'
                    },
                    {
                        id: 'cortexm.datatrace.all.xy',
                        group: 'Cortex-M Data Trace Signals',
                        role: 'all',
                        displayMode: 'classic',
                        label: 'All Signals'
                    }
                ]
            }
        );

        expect(entries.map(entry => ({ name: entry.name, parentId: entry.parentId }))).toEqual([
            { name: 'Cortex-M Data Trace Signals', parentId: undefined },
            { name: 'All Signals', parentId: entries[0].id }
        ]);
    });

    test('builds XML time graph groups from explicit view metadata', () => {
        const entries = createAvailableViewEntries(
            [
                output('cortexm.rtos.thread.lanes.timegraph', 'Cortex-M RTOS Thread State: Thread States'),
                output('cortexm.rtos.thread.timegraph', 'Cortex-M RTOS Thread State: CMSIS-RTOS2 Thread States'),
                output('server.thread.timegraph', 'Cortex-M RTOS Thread State: Raw Server Thread States'),
                output('org.eclipse.tracecompass.internal.tmf.core.histogram.HistogramDataProvider', 'Histogram')
            ],
            {
                xmlViewMetadata: [
                    {
                        id: 'cortexm.rtos.thread.lanes.timegraph',
                        group: 'Cortex-M RTOS Thread State',
                        role: 'lanes',
                        displayMode: 'stacked',
                        label: 'Thread States'
                    },
                    {
                        id: 'cortexm.rtos.thread.timegraph',
                        group: 'Cortex-M RTOS Thread State',
                        role: 'all',
                        displayMode: 'classic',
                        label: 'All Signals'
                    }
                ]
            }
        );

        expect(entries.map(entry => ({ name: entry.name, parentId: entry.parentId }))).toEqual([
            { name: 'Cortex-M RTOS Thread State', parentId: undefined },
            { name: 'All Signals', parentId: entries[0].id },
            { name: 'Histogram', parentId: undefined }
        ]);
        expect(entries[0].output).toMatchObject({
            id: 'cortexm.rtos.thread.lanes.timegraph',
            traceViewerXmlViewMetadata: { displayMode: 'stacked' }
        });
        expect(entries[1].output).toMatchObject({
            id: 'cortexm.rtos.thread.timegraph',
            traceViewerXmlViewMetadata: { displayMode: 'classic' }
        });
        expect(entries.find(entry => entry.output?.id === 'server.thread.timegraph')).toBeUndefined();
    });

    test('preserves server-provided parent relationships', () => {
        const entries = createAvailableViewEntries([
            output('parent', 'Server Parent'),
            output('child', 'Server Parent: Child Label', 'parent')
        ]);

        expect(entries.map(entry => ({ id: entry.id, name: entry.name, parentId: entry.parentId }))).toEqual([
            { id: 'parent', name: 'Server Parent', parentId: undefined },
            { id: 'child', name: 'Server Parent: Child Label', parentId: 'parent' }
        ]);
    });

    test('keeps stale channel-prefixed descriptors unless they are explicitly described by XML metadata', () => {
        const entries = createAvailableViewEntries([
            xmlOutput('cortexm.datatrace.lanes.xy', 'Cortex-M Data Trace Signals: Signal Lanes'),
            xmlOutput('cortexm.datatrace.all.xy', 'Cortex-M Data Trace Signals: All Signals'),
            xmlOutput('stale.sine.xy', 'Cortex-M Data Trace Signals: CH0 Sine int16'),
            xmlOutput('cortexm.datatrace.sine.xy', 'Cortex-M Data Trace Signals: Sine int16'),
            xmlOutput('stale.square.xy', 'Cortex-M Data Trace Signals: CH1 Square uint32'),
            xmlOutput('cortexm.datatrace.square.xy', 'Cortex-M Data Trace Signals: Square uint32'),
            xmlOutput('unique.channel.xy', 'Cortex-M Data Trace Signals: CH2 Only Channel')
        ]);

        expect(entries.map(entry => entry.name)).toEqual([
            'Cortex-M Data Trace Signals: Signal Lanes',
            'Cortex-M Data Trace Signals: All Signals',
            'Cortex-M Data Trace Signals: CH0 Sine int16',
            'Cortex-M Data Trace Signals: Sine int16',
            'Cortex-M Data Trace Signals: CH1 Square uint32',
            'Cortex-M Data Trace Signals: Square uint32',
            'Cortex-M Data Trace Signals: CH2 Only Channel'
        ]);
        expect(entries.find(entry => entry.output?.id === 'stale.sine.xy')).toBeDefined();
        expect(entries.find(entry => entry.output?.id === 'stale.square.xy')).toBeDefined();
    });
});

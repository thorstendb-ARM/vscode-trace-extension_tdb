import { XyEntry } from 'tsp-typescript-client/lib/models/xy';
import { buildTreeStateFromModel, normalizeCheckedSeries } from '../xy-shared';

jest.mock('d3-axis', () => ({ axisLeft: jest.fn() }));
jest.mock('d3-scale', () => ({ scaleLinear: jest.fn() }));
jest.mock('d3-selection', () => ({ select: jest.fn() }));

describe('buildTreeStateFromModel', () => {
    test('uses server defaults when entries provide isDefault', () => {
        const entries: XyEntry[] = [
            { id: 1, parentId: -1, labels: ['DataTrace'], hasData: false },
            { id: 2, parentId: 1, labels: ['CH0'], hasData: true },
            { id: 3, parentId: 1, labels: ['CH1'], hasData: true, isDefault: true }
        ];

        const state = buildTreeStateFromModel({ entries });

        expect(state.checkedSeries).toEqual([3]);
    });

    test('does not select data leaf entries by default when no server defaults are provided', () => {
        const entries: XyEntry[] = [
            { id: 1, parentId: -1, labels: ['DataTrace'], hasData: true },
            { id: 2, parentId: 1, labels: ['CH0'], hasData: true },
            { id: 3, parentId: 1, labels: ['CH1'], hasData: true },
            { id: 4, parentId: 1, labels: ['Empty'], hasData: false }
        ];

        const state = buildTreeStateFromModel({ entries });

        expect(state.checkedSeries).toEqual([]);
    });

    test('selects data leaf entries when explicitly requested and no server defaults are provided', () => {
        const entries: XyEntry[] = [
            { id: 1, parentId: -1, labels: ['DataTrace'], hasData: true },
            { id: 2, parentId: 1, labels: ['CH0'], hasData: true },
            { id: 3, parentId: 1, labels: ['CH1'], hasData: true },
            { id: 4, parentId: 1, labels: ['Empty'], hasData: false }
        ];

        const state = buildTreeStateFromModel({ entries }, true);

        expect(state.checkedSeries).toEqual([2, 3]);
    });

    test('removes non-leaf entries from checked series', () => {
        const entries: XyEntry[] = [
            { id: 1, parentId: -1, labels: ['DataTrace'], hasData: true },
            { id: 2, parentId: 1, labels: ['CH0'], hasData: true },
            { id: 3, parentId: 1, labels: ['CH1'], hasData: true }
        ];

        expect(normalizeCheckedSeries(entries, [1, 2, 3])).toEqual([2, 3]);
        expect(normalizeCheckedSeries(entries, [1])).toEqual([]);
    });
});

import * as React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { TimeAxisComponent } from '../time-axis-component';
import { TimeGraphUnitController } from 'timeline-chart/lib/time-graph-unit-controller';
import { OutputComponentStyle } from '../output-component-style';
import { signalManager } from 'traceviewer-base/lib/signals/signal-manager';

describe('Time axis component', () => {
    let axisComponent: any;
    const ref = (el: TimeAxisComponent | undefined | null): void => {
        axisComponent = el;
    };

    beforeEach(() => {
        axisComponent = null;
    });

    afterEach(() => {
        cleanup();
        jest.clearAllMocks();
    });

    it('renders with provided style', () => {
        const unitController: TimeGraphUnitController = new TimeGraphUnitController(BigInt(10), {
            start: BigInt(0),
            end: BigInt(10)
        });
        const style: OutputComponentStyle = {
            width: 600,
            chartOffset: 200,
            componentLeft: 0,
            height: 100,
            rowHeight: 100,
            naviBackgroundColor: 0xf4f7fb,
            chartBackgroundColor: 0xf4f7fb,
            cursorColor: 0x259fd8,
            lineColor: 0x757575
        };
        render(
            <div>
                <TimeAxisComponent
                    unitController={unitController}
                    style={{ ...style, verticalAlign: 'bottom' }}
                    addWidgetResizeHandler={() => null}
                    removeWidgetResizeHandler={() => null}
                    ref={ref}
                />
            </div>
        );
        expect(axisComponent).toBeTruthy();
        expect(axisComponent instanceof TimeAxisComponent).toBe(true);
    });

    it('creates canvas', () => {
        const unitController: TimeGraphUnitController = new TimeGraphUnitController(BigInt(10), {
            start: BigInt(0),
            end: BigInt(10)
        });
        const style: OutputComponentStyle = {
            width: 600,
            chartOffset: 200,
            componentLeft: 0,
            height: 100,
            rowHeight: 100,
            naviBackgroundColor: 0xf4f7fb,
            chartBackgroundColor: 0xf4f7fb,
            cursorColor: 0x259fd8,
            lineColor: 0x757575
        };

        const { container } = render(
            <div>
                <TimeAxisComponent
                    unitController={unitController}
                    style={{ ...style, verticalAlign: 'bottom' }}
                    addWidgetResizeHandler={() => null}
                    removeWidgetResizeHandler={() => null}
                />
            </div>
        );
        expect(container).toMatchSnapshot();
    });

    it('renders signal lane cursor and marker time boxes at their lane x positions', () => {
        const unitController: TimeGraphUnitController = new TimeGraphUnitController(BigInt(2000000), {
            start: BigInt(0),
            end: BigInt(2000000)
        });
        unitController.selectionRange = { start: BigInt(500000), end: BigInt(500000) };
        const style: OutputComponentStyle = {
            width: 600,
            chartOffset: 200,
            componentLeft: 0,
            height: 100,
            rowHeight: 100,
            naviBackgroundColor: 0xf4f7fb,
            chartBackgroundColor: 0xf4f7fb,
            cursorColor: 0x259fd8,
            lineColor: 0x757575
        };

        render(
            <TimeAxisComponent
                unitController={unitController}
                style={{ ...style, verticalAlign: 'bottom' }}
                addWidgetResizeHandler={() => null}
                removeWidgetResizeHandler={() => null}
            />
        );

        act(() => {
            signalManager().emit('SIGNAL_LANE_CURSOR_UPDATED', {
                visible: true,
                x: 350,
                time: BigInt(1000000),
                plotLeft: 100,
                plotWidth: 500
            });
        });

        expect(screen.getByText('500us').style.left).toBe('225px');
        expect(screen.getByText(/1ms\s+Δ 500us/).style.left).toBe('350px');
    });
});

import * as React from 'react';
import { TimeGraphAxis } from 'timeline-chart/lib/layer/time-graph-axis';
import { TimeGraphAxisCursors } from 'timeline-chart/lib/layer/time-graph-axis-cursors';
import { ReactTimeGraphContainer } from './timegraph-container-component';
import { TimeGraphUnitController } from 'timeline-chart/lib/time-graph-unit-controller';
import { signalManager } from 'traceviewer-base/lib/signals/signal-manager';

interface TimeAxisProps {
    unitController: TimeGraphUnitController;
    style: {
        width: number;
        chartBackgroundColor: number;
        cursorColor: number;
        lineColor: number;
        verticalAlign: string;
    };
    addWidgetResizeHandler: (handler: () => void) => void;
    removeWidgetResizeHandler: (handler: () => void) => void;
}

interface TimeAxisState {
    signalLaneCursor?: {
        visible: boolean;
        x?: number;
        time?: bigint;
        plotLeft?: number;
        plotWidth?: number;
    };
}

export class TimeAxisComponent extends React.Component<TimeAxisProps, TimeAxisState> {
    constructor(props: TimeAxisProps) {
        super(props);
        this.state = {};
    }

    private readonly onSignalLaneCursorUpdated = (payload: {
        visible: boolean;
        x?: number;
        time?: bigint;
        plotLeft?: number;
        plotWidth?: number;
    }): void => {
        this.setState({ signalLaneCursor: payload });
    };

    componentDidMount(): void {
        signalManager().on('SIGNAL_LANE_CURSOR_UPDATED', this.onSignalLaneCursorUpdated);
    }

    componentWillUnmount(): void {
        signalManager().off('SIGNAL_LANE_CURSOR_UPDATED', this.onSignalLaneCursorUpdated);
    }

    render(): JSX.Element {
        return (
            <div style={{ position: 'relative', width: this.props.style.width, height: 30 }}>
                <ReactTimeGraphContainer
                    id="timegraph-axis"
                    options={{
                        id: 'timegraph-axis',
                        width: this.props.style.width,
                        height: 30,
                        backgroundColor: this.props.style.chartBackgroundColor,
                        lineColor: this.props.style.lineColor,
                        classNames: 'horizontal-canvas',
                        forceCanvasRenderer: true
                    }}
                    addWidgetResizeHandler={this.props.addWidgetResizeHandler}
                    removeWidgetResizeHandler={this.props.removeWidgetResizeHandler}
                    unitController={this.props.unitController}
                    layers={[this.getAxisLayer(), this.getAxisCursors()]}
                />
                {this.renderSignalLaneTimeBoxes()}
            </div>
        );
    }

    protected getAxisLayer(): TimeGraphAxis {
        const timeAxisLayer = new TimeGraphAxis('timeGraphAxis', {
            color: this.props.style.chartBackgroundColor,
            lineColor: this.props.style.lineColor,
            verticalAlign: this.props.style.verticalAlign
        });
        return timeAxisLayer;
    }

    protected getAxisCursors(): TimeGraphAxisCursors {
        return new TimeGraphAxisCursors('timeGraphAxisCursors', { color: this.props.style.cursorColor });
    }

    private renderSignalLaneTimeBoxes(): React.ReactNode {
        const cursor = this.state.signalLaneCursor;
        if (!cursor?.visible || cursor.x === undefined || cursor.time === undefined) {
            return undefined;
        }

        const fixedCursor = this.props.unitController.selectionRange?.start;
        const hasFixedCursor = fixedCursor !== undefined;
        const cursorLabel = this.formatCursorLabel(cursor.time);
        const markerLabel = hasFixedCursor ? this.formatTime(fixedCursor) : undefined;
        const cursorLeft = this.getBoxLeft(cursor.x, cursorLabel);
        const markerLeft =
            hasFixedCursor && markerLabel
                ? this.getBoxLeft(this.getXForSignalLaneTime(fixedCursor, cursor), markerLabel)
                : undefined;

        return (
            <>
                {hasFixedCursor && markerLabel && markerLeft !== undefined && (
                    <div style={this.getBoxStyle(markerLeft, '#9f9f9f', 1)}>{markerLabel}</div>
                )}
                <div style={this.getBoxStyle(cursorLeft, '#259fd8', hasFixedCursor ? 15 : 2)}>{cursorLabel}</div>
            </>
        );
    }

    private getXForSignalLaneTime(time: bigint, cursor: { plotLeft?: number; plotWidth?: number }): number {
        const viewRange = this.props.unitController.viewRange;
        const rangeLength = viewRange.end - viewRange.start;
        if (rangeLength <= BigInt(0)) {
            return cursor.plotLeft ?? 0;
        }
        const ratio = Number(time - viewRange.start) / Number(rangeLength);
        const plotLeft = cursor.plotLeft ?? 0;
        const plotWidth = cursor.plotWidth ?? this.props.style.width;
        return Math.max(0, Math.min(this.props.style.width, plotLeft + ratio * plotWidth));
    }

    private getBoxLeft(x: number, label: string): number {
        const estimatedWidth = Math.max(58, label.length * 7 + 10);
        const minLeft = estimatedWidth / 2;
        const maxLeft = Math.max(minLeft, this.props.style.width - estimatedWidth / 2);
        return Math.max(minLeft, Math.min(maxLeft, x));
    }

    private getBoxStyle(left: number, borderColor: string, top: number): React.CSSProperties {
        return {
            position: 'absolute',
            left,
            top,
            transform: 'translateX(-50%)',
            boxSizing: 'border-box',
            padding: '1px 4px',
            border: '1px solid ' + borderColor,
            background: '#202020',
            color: '#ffffff',
            fontSize: 11,
            lineHeight: '12px',
            whiteSpace: 'nowrap',
            pointerEvents: 'none'
        };
    }

    private formatCursorLabel(time: bigint): string {
        const current = this.formatTime(time);
        const fixedCursor = this.props.unitController.selectionRange?.start;
        if (fixedCursor === undefined) {
            return current;
        }
        return `${current}  Δ ${this.formatDuration(time - fixedCursor)}`;
    }

    private formatTime(time: bigint): string {
        return this.formatCompactTime(time);
    }

    private formatDuration(duration: bigint): string {
        return this.formatCompactTime(duration);
    }

    private formatCompactTime(time: bigint): string {
        const sign = time < BigInt(0) ? '-' : '';
        const abs = time < BigInt(0) ? -time : time;
        const units = [
            { suffix: 's', divisor: BigInt(1000000000) },
            { suffix: 'ms', divisor: BigInt(1000000) },
            { suffix: 'us', divisor: BigInt(1000) },
            { suffix: 'ns', divisor: BigInt(1) }
        ];
        const unit = units.find(candidate => abs >= candidate.divisor) ?? units[units.length - 1];
        const integer = abs / unit.divisor;
        const remainder = abs % unit.divisor;
        if (remainder === BigInt(0)) {
            return sign + integer.toString() + unit.suffix;
        }

        const decimal = ((remainder * BigInt(1000)) / unit.divisor).toString().padStart(3, '0').replace(/0+$/, '');
        return sign + integer.toString() + '.' + decimal + unit.suffix;
    }
}

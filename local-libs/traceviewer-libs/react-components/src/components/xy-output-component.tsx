/* eslint-disable @typescript-eslint/no-explicit-any */
import { AbstractOutputProps } from './abstract-output-component';
import * as React from 'react';
import { ResponseStatus } from 'tsp-typescript-client/lib/models/response/responses';
import Chart = require('chart.js');
import { BIMath } from 'timeline-chart/lib/bigint-utils';
import { scaleLinear } from 'd3-scale';
import {
    AbstractXYOutputComponent,
    AbstractXYOutputState,
    FLAG_PAN_LEFT,
    FLAG_PAN_RIGHT,
    FLAG_ZOOM_IN,
    FLAG_ZOOM_OUT,
    MouseButton
} from './abstract-xy-output-component';
import { TimeRange } from 'traceviewer-base/lib/utils/time-range';
import { validateNumArray } from './utils/filter-tree/utils';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faSpinner } from '@fortawesome/free-solid-svg-icons';
import { signalManager } from 'traceviewer-base/lib/signals/signal-manager';
import { XmlViewMetadata } from 'traceviewer-base/lib/signals/xml-view-metadata';

interface XmlConfiguredOutputDescriptor {
    traceViewerXmlViewMetadata?: XmlViewMetadata;
}

export class XYOutputComponent extends AbstractXYOutputComponent<AbstractOutputProps, AbstractXYOutputState> {
    private mousePanningStart = BigInt(0);
    private resolution = 0;
    private readonly lanePadding = 8;
    private readonly laneLabelWidth = 130;
    private readonly laneEdgePadding = 6;
    private laneDragSeriesId: number | undefined;
    private laneDragOrderIds: number[] | undefined;
    private cursorOverlayVisible = false;

    constructor(props: AbstractOutputProps) {
        super(props);
        this.state = {
            outputStatus: ResponseStatus.RUNNING,
            selectedSeriesId: [],
            xyTree: [],
            defaultOrderedIds: [],
            checkedSeries: validateNumArray(this.props.persistChartState?.checkedSeries)
                ? (this.props.persistChartState.checkedSeries as number[])
                : [],
            collapsedNodes: validateNumArray(this.props.persistChartState?.collapsedNodes)
                ? (this.props.persistChartState.collapsedNodes as number[])
                : [],
            xyData: {},
            columns: [{ title: 'Name', sortable: true }],
            allMax: 0,
            allMin: 0,
            cursor: 'default',
            showTree: true
        };
        this.addPinViewOptions(() => ({
            checkedSeries: this.state.checkedSeries,
            collapsedNodes: this.state.collapsedNodes
        }));
        this.addOptions('Export table to CSV...', () => this.exportOutput());
    }

    renderChart(): React.ReactNode {
        if (this.state.outputStatus === ResponseStatus.COMPLETED && this.state.xyData?.datasets?.length === 0) {
            return (
                <React.Fragment>
                    <div className="chart-message">Select a checkbox to see analysis results</div>
                </React.Fragment>
            );
        }
        return (
            <React.Fragment>
                <div
                    id={this.props.traceId + this.props.outputDescriptor.id + 'focusContainer'}
                    className="xy-main"
                    tabIndex={0}
                    onKeyDown={event => this.onKeyDown(event)}
                    onKeyUp={event => this.onKeyUp(event)}
                    onWheel={event => this.onWheel(event)}
                    onMouseMove={event => this.onMouseMove(event)}
                    onContextMenu={event => event.preventDefault()}
                    onMouseLeave={event => this.onMouseLeave(event)}
                    onMouseDown={event => this.onMouseDown(event)}
                    style={{ height: this.props.style.height, position: 'relative', cursor: this.state.cursor }}
                    ref={this.divRef}
                >
                    {this.renderSelectedChart()}
                    {this.renderCursorOverlay()}
                </div>
                {this.state.outputStatus === ResponseStatus.RUNNING && (
                    <div
                        id={this.props.traceId + this.props.outputDescriptor.id + 'focusContainer'}
                        className="analysis-running-overflow"
                        style={{ width: this.getChartWidth() }}
                    >
                        <div>
                            <FontAwesomeIcon icon={faSpinner} spin style={{ marginRight: '5px' }} />
                            <span>Analysis running</span>
                        </div>
                    </div>
                )}
            </React.Fragment>
        );
    }

    renderYAxis(): React.ReactNode {
        if (this.isSignalLanePlot()) {
            return <></>;
        }
        return super.renderYAxis();
    }

    protected isCanvasBackedChart(): boolean {
        return this.isBarPlot || this.isSignalLanePlot();
    }

    private isSignalLanePlot(): boolean {
        const xmlMetadata = (this.props.outputDescriptor as XmlConfiguredOutputDescriptor).traceViewerXmlViewMetadata;
        return xmlMetadata?.displayMode === 'stacked';
    }

    protected supportsPointSelectionMarker(): boolean {
        return true;
    }

    protected shouldSelectAllSeriesByDefault(): boolean {
        const xmlMetadata = (this.props.outputDescriptor as XmlConfiguredOutputDescriptor).traceViewerXmlViewMetadata;
        return this.isSignalLanePlot() || xmlMetadata?.role === 'signal';
    }

    protected getTimeForX(x: number): bigint {
        if (!this.isSignalLanePlot()) {
            return super.getTimeForX(x);
        }
        const bounds = this.getSignalLanePlotBounds(this.getChartWidth());
        const clampedX = Math.max(bounds.plotLeft, Math.min(x, bounds.plotRight));
        const normalizedX = ((clampedX - bounds.plotLeft) / bounds.plotWidth) * this.getChartWidth();
        return super.getTimeForX(normalizedX);
    }

    protected getXForTime(time: bigint): number {
        if (!this.isSignalLanePlot()) {
            return super.getXForTime(time);
        }
        const bounds = this.getSignalLanePlotBounds(this.getChartWidth());
        const normalizedX =
            super.getXForTime(this.toAbsoluteSignalLaneTime(time)) / Math.max(1, this.getChartWidth());
        return bounds.plotLeft + normalizedX * bounds.plotWidth;
    }

    private toAbsoluteSignalLaneTime(time: bigint): bigint {
        const offset = this.props.viewRange.getOffset?.() ?? BigInt(0);
        if (offset > BigInt(0) && time < offset) {
            return time + offset;
        }
        return time;
    }

    private toRelativeSignalLaneTime(time: bigint): bigint {
        const offset = this.props.viewRange.getOffset?.() ?? BigInt(0);
        if (offset > BigInt(0) && time >= offset) {
            return time - offset;
        }
        return time;
    }

    private getSignalLanePlotBounds(chartWidth: number): { plotLeft: number; plotRight: number; plotWidth: number } {
        const plotLeft = Math.min(this.laneLabelWidth, Math.floor(chartWidth * 0.35));
        const plotRight = Math.max(plotLeft + 1, chartWidth - this.laneEdgePadding);
        return {
            plotLeft,
            plotRight,
            plotWidth: Math.max(1, plotRight - plotLeft)
        };
    }

    private getSignalLaneSampleTime(labels: any[], index: number): bigint | undefined {
        const value = labels[index];
        if (typeof value === 'bigint') {
            return value;
        }
        if (typeof value === 'number' && Number.isFinite(value)) {
            return BigInt(Math.round(value));
        }
        if (typeof value === 'string') {
            const trimmed = value.trim();
            if (/^-?\d+$/.test(trimmed)) {
                return BigInt(trimmed);
            }
            const parsed = Number(trimmed);
            if (Number.isFinite(parsed)) {
                return BigInt(Math.round(parsed));
            }
        }
        return undefined;
    }

    private getSignalLaneSampleX(
        labels: any[],
        valueIndex: number,
        valueCount: number,
        plotLeft: number,
        plotWidth: number
    ): number {
        const sampleTime = this.getSignalLaneSampleTime(labels, valueIndex);
        if (sampleTime !== undefined) {
            return this.getXForTime(sampleTime);
        }
        return plotLeft + (valueIndex / Math.max(1, valueCount - 1)) * plotWidth;
    }

    private getClosestSignalLaneSampleIndex(labels: any[], valueCount: number, time: bigint): number {
        let closestIndex: number | undefined;
        let closestDistance: bigint | undefined;
        for (let i = 0; i < valueCount; i++) {
            const sampleTime = this.getSignalLaneSampleTime(labels, i);
            if (sampleTime === undefined) {
                continue;
            }
            const relativeSampleTime = this.toRelativeSignalLaneTime(sampleTime);
            const distance = relativeSampleTime > time ? relativeSampleTime - time : time - relativeSampleTime;
            if (closestDistance === undefined || distance < closestDistance) {
                closestDistance = distance;
                closestIndex = i;
            }
        }
        if (closestIndex !== undefined) {
            return closestIndex;
        }
        const bounds = this.getSignalLanePlotBounds(this.getChartWidth());
        return Math.max(
            0,
            Math.min(
                valueCount - 1,
                Math.round(((this.positionXMove - bounds.plotLeft) / bounds.plotWidth) * (valueCount - 1))
            )
        );
    }

    private renderSelectedChart(): JSX.Element {
        if (this.isSignalLanePlot()) {
            return this.drawSignalLaneChart();
        }
        if (this.isBarPlot) {
            return this.drawD3Chart();
        }
        return this.chooseChart();
    }

    private renderCursorOverlay(): React.ReactNode {
        if (
            !this.cursorOverlayVisible ||
            this.isMouseLeave ||
            this.isSignalLanePlot() ||
            !this.state.xyData?.datasets?.length
        ) {
            return undefined;
        }
        const chartWidth = this.getChartWidth();
        const x = Math.max(0, Math.min(this.getXForTime(this.getTimeForX(this.positionXMove)), chartWidth));
        return (
            <div
                style={{
                    position: 'absolute',
                    left: x,
                    top: 0,
                    height: this.props.style.height,
                    borderLeft: '1px solid #259fd8',
                    pointerEvents: 'none',
                    zIndex: 20
                }}
            />
        );
    }

    private drawD3Chart(): JSX.Element {
        const chartHeight = parseInt(this.props.style.height.toString());
        const chartWidth = this.getChartWidth();

        if (this.state.xyData.labels?.length > 0) {
            const data: any[] = [];

            this.state.xyData?.datasets?.forEach((dSet: any) => {
                const row: any = [];
                if (this.isScatterPlot) {
                    dSet.data.forEach((tupple: any) => {
                        row.push({ xValue: tupple.x, yValue: tupple.y });
                    });
                } else {
                    dSet.data.forEach((y: number, j: number) => {
                        row.push({ xValue: this.state.xyData.labels[j], yValue: y });
                    });
                }
                data.push(row);
            });

            const yScale = scaleLinear()
                .domain([this.state.allMin, Math.max(this.state.allMax, 1)])
                .range([chartHeight - this.margin.bottom, this.margin.top]);

            const xDomain = this.state.xyData.labels.length - 1;
            const start = this.getXForTime(this.state.xyData.labels[0]);
            const end = this.getXForTime(this.state.xyData.labels[xDomain]);

            const xScale = scaleLinear().domain([start, end].map(Number)).range([0, chartWidth]);

            if (this.chartRef.current) {
                const ctx = this.chartRef.current.getContext('2d');

                // Fix blurred lines in retina displays
                const dpr = window.devicePixelRatio;
                this.chartRef.current.width = dpr * chartWidth;
                this.chartRef.current.height = dpr * chartHeight;
                this.chartRef.current.style.width = chartWidth + 'px';
                this.chartRef.current.style.height = chartHeight + 'px';
                ctx.scale(dpr, dpr);

                // Bar chart
                if (ctx) {
                    ctx.clearRect(0, 0, chartWidth, chartHeight);
                    ctx.save();
                    data.forEach((row, i) => {
                        ctx.fillStyle = this.state.xyData.datasets[i].borderColor;
                        row.forEach((tupple: any) => {
                            ctx.beginPath();
                            const xPos = this.getXForTime(tupple.xValue);
                            ctx.fillRect(xScale(xPos), chartHeight, 2, -chartHeight + yScale(+tupple.yValue));
                            ctx.closePath();
                        });
                    });
                    ctx.restore();
                    this.afterChartDraw(this.chartRef.current.getContext('2d'));
                }
            }
        }

        return <canvas ref={this.chartRef} height={chartHeight} width={chartWidth} />;
    }

    private getSignalLaneIndexAtY(y: number): number | undefined {
        const datasets = this.state.xyData?.datasets ?? [];
        if (!this.isSignalLanePlot() || datasets.length === 0) {
            return undefined;
        }
        const chartHeight = parseInt(this.props.style.height.toString());
        const laneHeight = chartHeight / datasets.length;
        return Math.max(0, Math.min(datasets.length - 1, Math.floor(y / Math.max(1, laneHeight))));
    }

    private getSignalLaneSeriesIdAtLabel(x: number, y: number): number | undefined {
        const datasets = this.state.xyData?.datasets ?? [];
        if (x < 0 || x > this.getSignalLanePlotBounds(this.getChartWidth()).plotLeft) {
            return undefined;
        }
        const laneIndex = this.getSignalLaneIndexAtY(y);
        if (laneIndex === undefined) {
            return undefined;
        }
        const seriesId = datasets[laneIndex]?.seriesId;
        return typeof seriesId === 'number' ? seriesId : undefined;
    }

    private moveInOrder(orderIds: number[], seriesId: number, targetIndex: number): number[] {
        const fromIndex = orderIds.indexOf(seriesId);
        if (fromIndex === -1 || fromIndex === targetIndex) {
            return orderIds;
        }
        const next = [...orderIds];
        next.splice(fromIndex, 1);
        next.splice(targetIndex, 0, seriesId);
        return next;
    }

    private applySignalLaneOrder(orderIds: number[], commit: boolean): void {
        const order = new Map(orderIds.map((id, index) => [id, index]));
        const xyData = this.state.xyData ?? {};
        const datasets = [...(xyData.datasets ?? [])].sort((a: any, b: any) => {
            const aIndex = order.get(a.seriesId) ?? Number.MAX_SAFE_INTEGER;
            const bIndex = order.get(b.seriesId) ?? Number.MAX_SAFE_INTEGER;
            return aIndex - bIndex;
        });
        const updates: Partial<AbstractXYOutputState> = {
            xyData: {
                ...xyData,
                datasets
            }
        };
        if (commit) {
            const checked = new Set(this.state.checkedSeries);
            updates.checkedSeries = orderIds.filter(id => checked.has(id));
        }
        this.setState(updates as AbstractXYOutputState);
    }

    private readonly endSignalLaneDrag = (_event: MouseEvent): void => {
        if (this.laneDragOrderIds) {
            this.applySignalLaneOrder(this.laneDragOrderIds, true);
        }
        this.laneDragSeriesId = undefined;
        this.laneDragOrderIds = undefined;
        this.setState({ cursor: 'default' });
        document.removeEventListener('mouseup', this.endSignalLaneDrag);
    };

    private drawSignalLaneChart(): JSX.Element {
        const chartHeight = parseInt(this.props.style.height.toString());
        const chartWidth = this.getChartWidth();

        if (this.chartRef.current) {
            const ctx = this.chartRef.current.getContext('2d');
            const datasets = this.state.xyData?.datasets ?? [];
            const labels = this.state.xyData?.labels ?? [];

            if (ctx) {
                const dpr = window.devicePixelRatio || 1;
                this.chartRef.current.width = dpr * chartWidth;
                this.chartRef.current.height = dpr * chartHeight;
                this.chartRef.current.style.width = chartWidth + 'px';
                this.chartRef.current.style.height = chartHeight + 'px';
                ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
                ctx.clearRect(0, 0, chartWidth, chartHeight);

                const { plotLeft, plotRight, plotWidth } = this.getSignalLanePlotBounds(chartWidth);
                const laneCount = Math.max(1, datasets.length);
                const laneHeight = chartHeight / laneCount;
                const fontColor = this.props.backgroundTheme === 'dark' ? '#d8d8d8' : '#303030';
                const mutedColor = this.props.backgroundTheme === 'dark' ? '#777777' : '#b8b8b8';
                const cursorReadouts: Array<{ color: string; value: string; y: number }> = [];

                ctx.save();
                ctx.font = '11px sans-serif';
                ctx.textBaseline = 'middle';

                datasets.forEach((dataset: any, index: number) => {
                    const top = index * laneHeight;
                    const bottom = top + laneHeight;
                    const centerY = top + laneHeight / 2;
                    const values = (dataset.data ?? []).map(Number).filter(Number.isFinite);
                    if (values.length === 0 || labels.length === 0) {
                        return;
                    }

                    const min = Math.min(...values);
                    const max = Math.max(...values);
                    const range = max - min || 1;
                    const usableHeight = Math.max(1, laneHeight - this.lanePadding * 2);
                    const yForValue = (value: number): number =>
                        bottom - this.lanePadding - ((value - min) / range) * usableHeight;
                    const xForIndex = (valueIndex: number): number =>
                        this.getSignalLaneSampleX(labels, valueIndex, values.length, plotLeft, plotWidth);

                    ctx.strokeStyle = mutedColor;
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.moveTo(plotLeft, centerY);
                    ctx.lineTo(plotRight, centerY);
                    ctx.stroke();

                    ctx.fillStyle = fontColor;
                    const label = String(dataset.label ?? '');
                    ctx.fillText(label.length > 20 ? label.substring(0, 19) + '...' : label, 6, centerY);

                    ctx.strokeStyle = dataset.borderColor ?? '#259fd8';
                    ctx.lineWidth = 1.5;
                    ctx.save();
                    ctx.beginPath();
                    ctx.rect(plotLeft, top, plotWidth, laneHeight);
                    ctx.clip();
                    ctx.beginPath();
                    values.forEach((value: number, valueIndex: number) => {
                        const x = Math.max(
                            plotLeft - plotWidth,
                            Math.min(plotRight + plotWidth, xForIndex(valueIndex))
                        );
                        const y = yForValue(value);
                        if (valueIndex === 0) {
                            ctx.moveTo(x, y);
                        } else {
                            ctx.lineTo(x, y);
                        }
                    });
                    ctx.stroke();
                    ctx.restore();

                    if (this.positionXMove >= plotLeft && this.positionXMove <= plotRight) {
                        const closestIndex = this.getClosestSignalLaneSampleIndex(
                            labels,
                            values.length,
                            this.getTimeForX(this.positionXMove)
                        );
                        const value = values[closestIndex];
                        const y = yForValue(value);
                        const formattedValue = this.formatLaneValue(value);
                        const color = dataset.borderColor ?? '#259fd8';

                        ctx.fillStyle = color;
                        ctx.beginPath();
                        ctx.arc(this.positionXMove, y, 2.5, 0, Math.PI * 2);
                        ctx.fill();
                        cursorReadouts.push({
                            color,
                            value: formattedValue,
                            y: Math.max(top + 10, bottom - this.lanePadding - 6)
                        });
                    }
                });

                if (this.positionXMove >= plotLeft && this.positionXMove <= plotRight) {
                    ctx.strokeStyle = '#259fd8';
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.moveTo(this.positionXMove, 0);
                    ctx.lineTo(this.positionXMove, chartHeight);
                    ctx.stroke();
                    this.drawSignalLaneCursorReadouts(ctx, cursorReadouts, chartWidth, plotLeft, plotRight);
                }

                ctx.restore();
                this.afterChartDraw(ctx);
            }
        }

        return <canvas ref={this.chartRef} height={chartHeight} width={chartWidth} />;
    }

    private drawSignalLaneCursorReadouts(
        ctx: CanvasRenderingContext2D,
        readouts: Array<{ color: string; value: string; y: number }>,
        chartWidth: number,
        plotLeft: number,
        plotRight: number
    ): void {
        if (readouts.length === 0) {
            return;
        }

        const cursorGap = 6;
        const boxPaddingX = 4;
        const boxHeight = 14;
        const maxBoxWidth = Math.max(...readouts.map(readout => ctx.measureText(readout.value).width + boxPaddingX * 2));
        const placeLeft = this.positionXMove + cursorGap + maxBoxWidth > Math.min(chartWidth, plotRight);

        ctx.save();
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.font = '11px sans-serif';
        readouts.forEach(readout => {
            const boxWidth = Math.ceil(ctx.measureText(readout.value).width + boxPaddingX * 2);
            const boxX = placeLeft
                ? Math.max(plotLeft + cursorGap, this.positionXMove - cursorGap - boxWidth)
                : Math.min(plotRight - boxWidth, this.positionXMove + cursorGap);
            const boxY = readout.y - boxHeight / 2;
            ctx.fillStyle = '#202020';
            ctx.fillRect(boxX, boxY, boxWidth, boxHeight);
            ctx.strokeStyle = readout.color;
            ctx.lineWidth = 1;
            ctx.strokeRect(boxX + 0.5, boxY + 0.5, boxWidth - 1, boxHeight - 1);
            ctx.fillStyle = '#ffffff';
            ctx.fillText(readout.value, boxX + boxPaddingX, readout.y);
        });
        ctx.restore();
    }

    private formatLaneValue(value: number): string {
        const rounded = Math.round(value * 100) / 100;
        return new Intl.NumberFormat().format(rounded);
    }

    protected afterChartDraw(ctx: CanvasRenderingContext2D | null, chartArea?: Chart.ChartArea | null): void {
        if (ctx) {
            if (this.props.selectionRange) {
                const startPixel = this.getXForTime(this.props.selectionRange.getStart());
                const endPixel = this.getXForTime(this.props.selectionRange.getEnd());
                ctx.strokeStyle = '#259fd8';
                ctx.fillStyle = '#259fd8';
                this.drawSelection(ctx, chartArea, startPixel, endPixel);
            }
            if (this.clickedMouseButton === MouseButton.RIGHT) {
                const offset = this.props.viewRange.getOffset() ?? BigInt(0);
                const startPixel = this.getXForTime(this.startPositionMouseRightClick + offset);
                const endPixel = this.positionXMove;
                ctx.strokeStyle = '#9f9f9f';
                ctx.fillStyle = '#9f9f9f';
                this.drawSelection(ctx, chartArea, startPixel, endPixel);
            }
        }
    }

    private drawSelection(
        ctx: CanvasRenderingContext2D | null,
        chartArea: Chart.ChartArea | undefined | null,
        startPixel: number,
        endPixel: number
    ) {
        const minPixel = Math.min(startPixel, endPixel);
        const maxPixel = Math.max(startPixel, endPixel);
        const initialPoint = this.isCanvasBackedChart() ? 0 : (chartArea?.left ?? 0);
        const chartHeight = parseInt(this.props.style.height.toString());
        const finalPoint = this.isCanvasBackedChart() ? chartHeight : (chartArea?.bottom ?? 0);
        if (ctx) {
            ctx.save();

            ctx.lineWidth = 1;
            // Selection borders
            if (startPixel > initialPoint) {
                ctx.beginPath();
                ctx.moveTo(minPixel, 0);
                ctx.lineTo(minPixel, finalPoint);
                ctx.stroke();
            }
            if (endPixel < this.props.viewRange.getEnd()) {
                ctx.beginPath();
                ctx.moveTo(maxPixel, 0);
                ctx.lineTo(maxPixel, finalPoint);
                ctx.stroke();
            }
            // Selection fill
            ctx.globalAlpha = 0.2;
            ctx.fillRect(minPixel, 0, maxPixel - minPixel, finalPoint);
            ctx.restore();
        }
    }

    private onMouseDown(event: React.MouseEvent<HTMLDivElement, MouseEvent>): void {
        if (this.isSignalLanePlot() && event.button === MouseButton.LEFT && !event.shiftKey && !event.ctrlKey) {
            const seriesId = this.getSignalLaneSeriesIdAtLabel(event.nativeEvent.offsetX, event.nativeEvent.offsetY);
            if (seriesId !== undefined) {
                this.laneDragSeriesId = seriesId;
                this.laneDragOrderIds = (this.state.xyData?.datasets ?? [])
                    .map((dataset: any) => dataset.seriesId)
                    .filter((id: unknown): id is number => typeof id === 'number');
                this.setState({ cursor: 'grabbing' });
                document.addEventListener('mouseup', this.endSignalLaneDrag);
                event.preventDefault();
                return;
            }
        }

        this.isMouseLeave = false;
        this.mouseIsDown = true;
        this.posPixelSelect = event.nativeEvent.screenX;
        this.positionXMove = event.nativeEvent.offsetX;
        this.positionYMove = event.nativeEvent.offsetY;
        const startTime = this.getTimeForX(event.nativeEvent.offsetX);
        this.clickedMouseButton = event.button;

        if (this.clickedMouseButton === MouseButton.RIGHT) {
            this.isSelecting = false;
            this.setState({ cursor: 'col-resize' });
            this.startPositionMouseRightClick = startTime;
        } else {
            if (this.clickedMouseButton === MouseButton.LEFT) {
                this.startPositionMouseLeftClick = startTime;
            }
            if (event.shiftKey && !event.ctrlKey && this.props.unitController.selectionRange) {
                this.isSelecting = true;
                this.setState({ cursor: 'crosshair' });
                this.props.unitController.selectionRange = {
                    start: this.props.unitController.selectionRange.start,
                    end: startTime
                };
            } else if (
                (event.ctrlKey && !event.shiftKey) ||
                (!(event.shiftKey && event.ctrlKey) && this.clickedMouseButton === MouseButton.MID)
            ) {
                this.resolution = this.getChartWidth() / Number(this.props.unitController.viewRangeLength);
                this.mousePanningStart =
                    this.props.unitController.viewRange.start + BIMath.round(event.nativeEvent.x / this.resolution);
                this.isPanning = true;
                this.setState({ cursor: 'grabbing' });
            } else if (!(event.shiftKey && event.ctrlKey)) {
                this.setState({ cursor: 'crosshair' });
                if (!this.isSignalLanePlot()) {
                    this.isSelecting = true;
                    this.props.unitController.selectionRange = {
                        start: startTime,
                        end: startTime
                    };
                }
            }
            this.onMouseMove(event);
        }
        document.addEventListener('mouseup', this.endSelection);
    }

    private panHorizontally(event: React.MouseEvent) {
        const delta = event.nativeEvent.x;
        const change = Number(this.mousePanningStart) - delta / this.resolution;
        const min = BigInt(0);
        const max = this.props.unitController.absoluteRange - this.props.unitController.viewRangeLength;
        const start = BIMath.clamp(change, min, max);
        const end = start + this.props.unitController.viewRangeLength;
        this.props.unitController.viewRange = {
            start,
            end
        };
    }

    private onWheel(wheel: React.WheelEvent): void {
        this.isMouseLeave = false;
        if (wheel.shiftKey) {
            if (wheel.deltaY < 0) {
                this.pan(FLAG_PAN_LEFT);
            } else if (wheel.deltaY > 0) {
                this.pan(FLAG_PAN_RIGHT);
            }
        } else if (wheel.ctrlKey) {
            if (wheel.deltaY < 0) {
                this.zoom(FLAG_ZOOM_IN);
            } else if (wheel.deltaY > 0) {
                this.zoom(FLAG_ZOOM_OUT);
            }
        }
    }

    private onMouseMove(event: React.MouseEvent): void {
        this.positionXMove = event.nativeEvent.offsetX;
        this.positionYMove = event.nativeEvent.offsetY;
        this.isMouseLeave = false;
        this.cursorOverlayVisible = true;

        if (this.laneDragSeriesId !== undefined && this.laneDragOrderIds) {
            const targetIndex = this.getSignalLaneIndexAtY(event.nativeEvent.offsetY);
            if (targetIndex !== undefined) {
                const nextOrder = this.moveInOrder(this.laneDragOrderIds, this.laneDragSeriesId, targetIndex);
                if (nextOrder !== this.laneDragOrderIds) {
                    this.laneDragOrderIds = nextOrder;
                    this.applySignalLaneOrder(nextOrder, false);
                }
            }
            return;
        }

        if (this.isSignalLanePlot()) {
            const hoverSeriesId = this.getSignalLaneSeriesIdAtLabel(event.nativeEvent.offsetX, event.nativeEvent.offsetY);
            const nextCursor = hoverSeriesId !== undefined ? 'grab' : 'default';
            if (!this.mouseIsDown && this.state.cursor !== nextCursor) {
                this.setState({ cursor: nextCursor });
            }
        }

        if (this.mouseIsDown) {
            if (this.isPanning) {
                this.panHorizontally(event);
            } else if (this.isSelecting) {
                this.updateSelection();
            } else if (
                this.clickedMouseButton === MouseButton.LEFT &&
                Math.abs(event.nativeEvent.screenX - this.posPixelSelect) > 1
            ) {
                this.isSelecting = true;
                this.props.unitController.selectionRange = {
                    start: this.startPositionMouseLeftClick,
                    end: this.getTimeForX(this.positionXMove)
                };
            } else {
                this.forceUpdate();
            }
        }
        if (this.isSignalLanePlot()) {
            const bounds = this.getSignalLanePlotBounds(this.getChartWidth());
            if (this.state.tooltipVisible) {
                this.closeTooltip();
            }
            if (this.positionXMove >= bounds.plotLeft && this.positionXMove <= bounds.plotRight) {
                const time = this.getTimeForX(this.positionXMove);
                signalManager().emit('SIGNAL_LANE_CURSOR_UPDATED', {
                    visible: true,
                    x: this.getXForTime(time),
                    time,
                    plotLeft: bounds.plotLeft,
                    plotWidth: bounds.plotWidth
                });
            } else {
                signalManager().emit('SIGNAL_LANE_CURSOR_UPDATED', { visible: false });
            }
            this.forceUpdate();
            return;
        }
        signalManager().emit('SIGNAL_LANE_CURSOR_UPDATED', {
            visible: true,
            x: this.getXForTime(this.getTimeForX(this.positionXMove)),
            time: this.getTimeForX(this.positionXMove),
            plotLeft: 0,
            plotWidth: this.getChartWidth()
        });
        this.forceUpdate();
        if (this.state.xyData?.datasets?.length > 0) {
            this.tooltip();
        }
    }

    private onMouseLeave(event: React.MouseEvent) {
        this.isMouseLeave = true;
        this.cursorOverlayVisible = false;
        const width = this.isCanvasBackedChart() ? this.getChartWidth() : this.chartRef.current.chartInstance.width;
        this.positionXMove = Math.max(0, Math.min(event.nativeEvent.offsetX, width));
        this.forceUpdate();
        if (this.mouseIsDown && !(this.clickedMouseButton === MouseButton.RIGHT)) {
            this.updateSelection();
        }
        if (this.isSignalLanePlot()) {
            signalManager().emit('SIGNAL_LANE_CURSOR_UPDATED', { visible: false });
        } else {
            signalManager().emit('SIGNAL_LANE_CURSOR_UPDATED', { visible: false });
        }
        this.closeTooltip();
    }

    private onKeyDown(key: React.KeyboardEvent): void {
        this.closeTooltip();
        if (!this.isMouseLeave) {
            switch (key.key) {
                case 'W':
                case 'w':
                case 'i':
                case 'I': {
                    this.zoom(FLAG_ZOOM_IN);
                    break;
                }
                case 'S':
                case 's':
                case 'K':
                case 'k': {
                    this.zoom(FLAG_ZOOM_OUT);
                    break;
                }
                case 'A':
                case 'a':
                case 'J':
                case 'j':
                case 'ArrowLeft': {
                    this.pan(FLAG_PAN_LEFT);
                    break;
                }
                case 'D':
                case 'd':
                case 'L':
                case 'l':
                case 'ArrowRight': {
                    this.pan(FLAG_PAN_RIGHT);
                    break;
                }
                case 'Shift': {
                    if (!this.isPanning && !(this.clickedMouseButton === MouseButton.RIGHT) && !this.isSelecting) {
                        if (key.ctrlKey) {
                            this.setState({ cursor: 'default' });
                        } else {
                            this.setState({ cursor: 'crosshair' });
                        }
                    }
                    break;
                }
                case 'Control': {
                    if (!this.isSelecting && !this.isPanning) {
                        if (key.shiftKey) {
                            this.setState({ cursor: 'default' });
                        } else {
                            this.setState({ cursor: 'grabbing' });
                        }
                    }
                    break;
                }
            }
        }
    }

    private onKeyUp(key: React.KeyboardEvent): void {
        if (!this.isSelecting && !this.isPanning) {
            let keyCursor: string | undefined = this.state.cursor ?? 'default';
            if (key.key === 'Shift') {
                if (key.ctrlKey) {
                    keyCursor = 'grabbing';
                } else if (!this.mouseIsDown) {
                    keyCursor = 'default';
                }
            } else if (key.key === 'Control') {
                if (key.shiftKey) {
                    keyCursor = 'crosshair';
                } else if (!this.mouseIsDown) {
                    this.isPanning = false;
                    keyCursor = 'default';
                }
            }
            this.setState({ cursor: keyCursor });
        }
    }

    protected getDisplayedRange(): TimeRange {
        return this.props.viewRange;
    }

    protected getZoomTime(): bigint {
        return this.getTimeForX(this.positionXMove);
    }

    private exportOutput() {
        const columnLabels = this.state.columns.map(col => col.title);
        const tableContent = this.state.xyTree.map(rowData => rowData.labels);
        const tableString = columnLabels.join(',') + '\n' + tableContent.map(row => row.join(',')).join('\n');
        signalManager().emit('SAVE_AS_CSV', this.props.traceId, tableString);
        this.setState({
            dropDownOpen: false
        });
    }
}

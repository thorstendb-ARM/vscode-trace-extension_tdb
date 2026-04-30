export type XmlViewRole = 'lanes' | 'all' | 'signal';
export type XmlViewDisplayMode = 'stacked' | 'classic';

export interface XmlViewStateValue {
    value: string;
    label: string;
    color?: string;
}

export interface XmlViewMetadata {
    id: string;
    group: string;
    role?: XmlViewRole;
    displayMode?: XmlViewDisplayMode;
    label?: string;
    stateValues?: XmlViewStateValue[];
}

export interface XmlViewMetadataPayload {
    views: XmlViewMetadata[];
}

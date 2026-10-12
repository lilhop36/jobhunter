import { LocationCategory, RemoteStatus } from '@domain/enums';

export interface LocationClassified {
  category: LocationCategory;
  remoteStatus: RemoteStatus;
  confidence: number;
  evidence: string | null;
  signals: string[];
}

export interface LocationClassifyInput {
  text: string | null | undefined;
}

export function classifyLocation(input: LocationClassifyInput): LocationClassified {
  if (!input.text) {
    return {
      category: LocationCategory.UNKNOWN,
      remoteStatus: RemoteStatus.UNKNOWN,
      confidence: 0,
      evidence: null,
      signals: [],
    };
  }
  const raw = input.text.trim();
  if (!raw) {
    return {
      category: LocationCategory.UNKNOWN,
      remoteStatus: RemoteStatus.UNKNOWN,
      confidence: 0,
      evidence: null,
      signals: [],
    };
  }
  const normalized = raw.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const signals: string[] = [];
  if (/hybrid/.test(normalized)) {
    signals.push('hybrid');
    return {
      category: LocationCategory.HYBRID,
      remoteStatus: RemoteStatus.HYBRID,
      confidence: 90,
      evidence: raw,
      signals,
    };
  }
  if (/remote/.test(normalized)) {
    signals.push('remote');
    if (/ethiopia|addis|finfinne|አዲስ/.test(normalized)) {
      return {
        category: LocationCategory.ETHIOPIA_REMOTE,
        remoteStatus: RemoteStatus.REMOTE,
        confidence: 85,
        evidence: raw,
        signals,
      };
    }
    if (/international|abroad|overseas|global|world/.test(normalized)) {
      return {
        category: LocationCategory.INTERNATIONAL_REMOTE,
        remoteStatus: RemoteStatus.REMOTE,
        confidence: 85,
        evidence: raw,
        signals,
      };
    }
    return {
      category: LocationCategory.UNKNOWN,
      remoteStatus: RemoteStatus.REMOTE,
      confidence: 60,
      evidence: raw,
      signals,
    };
  }
  if (/addis|addis ababa|finfinne|አዲስ አበባ/.test(normalized)) {
    signals.push('addis_ababa');
    return {
      category: LocationCategory.ADDIS_ABABA,
      remoteStatus: RemoteStatus.ONSITE,
      confidence: 95,
      evidence: raw,
      signals,
    };
  }
  return {
    category: LocationCategory.UNKNOWN,
    remoteStatus: RemoteStatus.UNKNOWN,
    confidence: 0,
    evidence: raw,
    signals,
  };
}

import { LocationCategory, RemoteStatus } from '@domain/enums';
import { asProbability, Probability } from '@domain/types';
import {
  ADDIS_ABABA_ALIASES,
  ETHIOPIAN_CITIES,
  ETHIOPIAN_REGIONS,
  FOREIGN_CITIES,
  FOREIGN_COUNTRIES,
  HYBRID_MARKERS,
  INTERNATIONAL_MARKERS,
  REMOTE_MARKERS,
} from './gazetteer';

export interface LocationClassified {
  category: LocationCategory;
  remoteStatus: RemoteStatus;
  /** Extraction confidence in [0, 1] (SRS B.1/B.2 convention). Not a match score. */
  confidence: Probability;
  evidence: string | null;
  signals: string[];
}

export interface LocationClassifyInput {
  text: string | null | undefined;
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s.]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchesAny(normalized: string, terms: string[]): string[] {
  const found: string[] = [];
  for (const term of terms) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(?:^|\\s)${escaped}(?=$|\\s)`, 'i');
    if (pattern.test(normalized)) found.push(term);
  }
  return found;
}

function emptyResult(evidence: string | null, signals: string[] = []): LocationClassified {
  return {
    category: LocationCategory.UNKNOWN,
    remoteStatus: RemoteStatus.UNKNOWN,
    confidence: asProbability(0),
    evidence,
    signals,
  };
}

export function classifyLocation(input: LocationClassifyInput): LocationClassified {
  if (input.text === null || input.text === undefined) return emptyResult(null);
  const raw = input.text.trim();
  if (!raw) return emptyResult(null);

  const normalized = normalize(raw);
  const signals: string[] = [];

  const hybridHits = matchesAny(normalized, HYBRID_MARKERS);
  const remoteHits = matchesAny(normalized, REMOTE_MARKERS);
  const internationalHits = matchesAny(normalized, INTERNATIONAL_MARKERS);
  const addisHits = matchesAny(normalized, ADDIS_ABABA_ALIASES);
  const cityHits = matchesAny(normalized, ETHIOPIAN_CITIES);
  const regionHits = matchesAny(normalized, ETHIOPIAN_REGIONS);
  const countryHits = matchesAny(normalized, FOREIGN_COUNTRIES);
  const foreignCityHits = matchesAny(normalized, FOREIGN_CITIES);

  // 'ethiopia' is a country wrapper, not a competing place signal.
  const regionHitsReal = regionHits.filter((r) => r !== 'ethiopia');
  const ethiopianPlace = addisHits.length > 0 || cityHits.length > 0 || regionHits.length > 0;
  const foreignPlace = countryHits.length > 0 || foreignCityHits.length > 0;

  // 1. Hybrid wins outright.
  if (hybridHits.length > 0) {
    signals.push('hybrid', ...hybridHits);
    return {
      category: LocationCategory.HYBRID,
      remoteStatus: RemoteStatus.HYBRID,
      confidence: asProbability(0.9),
      evidence: raw,
      signals,
    };
  }

  // 7. Conflicting Ethiopian + foreign signals -> UNKNOWN.
  if (ethiopianPlace && foreignPlace) {
    signals.push('CONFLICTING', ...addisHits, ...cityHits, ...regionHits, ...countryHits, ...foreignCityHits);
    return {
      category: LocationCategory.UNKNOWN,
      remoteStatus: RemoteStatus.UNKNOWN,
      confidence: asProbability(0),
      evidence: raw,
      signals,
    };
  }

  if (remoteHits.length > 0) {
    signals.push('remote', ...remoteHits);
    if (ethiopianPlace) {
      signals.push(...addisHits, ...cityHits, ...regionHits);
      return {
        category: LocationCategory.ETHIOPIA_REMOTE,
        remoteStatus: RemoteStatus.REMOTE,
        confidence: asProbability(0.85),
        evidence: raw,
        signals,
      };
    }
    if (foreignPlace || internationalHits.length > 0) {
      signals.push(...internationalHits, ...countryHits, ...foreignCityHits);
      return {
        category: LocationCategory.INTERNATIONAL_REMOTE,
        remoteStatus: RemoteStatus.REMOTE,
        confidence: asProbability(0.85),
        evidence: raw,
        signals,
      };
    }
    // 4. Remote with no geography -> category UNKNOWN, remoteStatus REMOTE.
    return {
      category: LocationCategory.UNKNOWN,
      remoteStatus: RemoteStatus.REMOTE,
      confidence: asProbability(0.6),
      evidence: raw,
      signals,
    };
  }

  // 5. Addis Ababa as the only place (country wrapper 'ethiopia' does not compete).
  if (addisHits.length > 0 && cityHits.length === 0 && regionHitsReal.length === 0) {
    signals.push(...addisHits, ...regionHits);
    return {
      category: LocationCategory.ADDIS_ABABA,
      remoteStatus: RemoteStatus.ONSITE,
      confidence: asProbability(0.95),
      evidence: raw,
      signals,
    };
  }

  // 6. Ethiopian city/region; multiple places => lower confidence.
  if (cityHits.length > 0 || regionHitsReal.length > 0) {
    signals.push(...addisHits, ...cityHits, ...regionHits);
    const multiple = cityHits.length + regionHitsReal.length + (addisHits.length > 0 ? 1 : 0) > 1;
    return {
      category: cityHits.length > 0 ? LocationCategory.ETHIOPIA_CITY : LocationCategory.ETHIOPIA_REGION,
      remoteStatus: RemoteStatus.ONSITE,
      confidence: asProbability(multiple ? 0.6 : 0.8),
      evidence: raw,
      signals,
    };
  }

  // 8. Foreign on-site.
  if (foreignPlace) {
    signals.push(...countryHits, ...foreignCityHits);
    return {
      category: LocationCategory.INTERNATIONAL_ON_SITE,
      remoteStatus: RemoteStatus.ONSITE,
      confidence: asProbability(0.75),
      evidence: raw,
      signals,
    };
  }

  // Unrecognized -> UNKNOWN (AC-008).
  return emptyResult(raw, signals);
}

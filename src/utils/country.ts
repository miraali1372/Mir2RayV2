import { ExitCountryProvenance } from '../types';

export type { ExitCountryProvenance };

export interface CountryInfo {
  code: string;
  name: string;
  flag: string;
}

const COUNTRY_MAP: Record<string, { name: string; flag: string }> = {
  US: { name: 'آمریکا', flag: '🇺🇸' },
  DE: { name: 'آلمان', flag: '🇩🇪' },
  NL: { name: 'هلند', flag: '🇳🇱' },
  GB: { name: 'انگلیس', flag: '🇬🇧' },
  UK: { name: 'انگلیس', flag: '🇬🇧' },
  FR: { name: 'فرانسه', flag: '🇫🇷' },
  TR: { name: 'ترکیه', flag: '🇹🇷' },
  SG: { name: 'سنگاپور', flag: '🇸🇬' },
  PL: { name: 'لهستان', flag: '🇵🇱' },
  FI: { name: 'فنلاند', flag: '🇫🇮' },
  RU: { name: 'روسیه', flag: '🇷🇺' },
  CA: { name: 'کانادا', flag: '🇨🇦' },
  JP: { name: 'ژاپن', flag: '🇯🇵' },
  KR: { name: 'کره جنوبی', flag: '🇰🇷' },
  AE: { name: 'امارات', flag: '🇦🇪' },
  IR: { name: 'ایران', flag: '🇮🇷' },
  IT: { name: 'ایتالیا', flag: '🇮🇹' },
  ES: { name: 'اسپانیا', flag: '🇪🇸' },
  SE: { name: 'سوئد', flag: '🇸🇪' },
  CH: { name: 'سوئیس', flag: '🇨🇭' },
  AT: { name: 'اتریش', flag: '🇦🇹' },
  KZ: { name: 'قزاقستان', flag: '🇰🇿' },
  AU: { name: 'استرالیا', flag: '🇦🇺' },
  IN: { name: 'هند', flag: '🇮🇳' },
  BR: { name: 'برزیل', flag: '🇧🇷' },
  UA: { name: 'اوکراین', flag: '🇺🇦' },
  RO: { name: 'رومانی', flag: '🇷🇴' },
  BG: { name: 'بلغارستان', flag: '🇧🇬' },
  CZ: { name: 'چک', flag: '🇨🇿' },
  NO: { name: 'نروژ', flag: '🇳🇴' },
  DK: { name: 'دانمارک', flag: '🇩🇰' },
  BE: { name: 'بلژیک', flag: '🇧🇪' },
  IE: { name: 'ایرلند', flag: '🇮🇪' },
  HK: { name: 'هنگ‌کنگ', flag: '🇭🇰' },
  TW: { name: 'تایوان', flag: '🇹🇼' },
  AM: { name: 'ارمنستان', flag: '🇦🇲' },
  GE: { name: 'گرجستان', flag: '🇬🇪' },
  AZ: { name: 'آذربایجان', flag: '🇦🇿' },
  IQ: { name: 'عراق', flag: '🇮🇶' },
  IL: { name: 'اسرائیل', flag: '🇮🇱' },
  GR: { name: 'یونان', flag: '🇬🇷' },
  PT: { name: 'پرتغال', flag: '🇵🇹' },
  HU: { name: 'مجارستان', flag: '🇭🇺' },
  MD: { name: 'مولداوی', flag: '🇲🇩' },
  RS: { name: 'صربستان', flag: '🇷🇸' },
  CY: { name: 'قبرس', flag: '🇨🇾' },
  LU: { name: 'لوکزامبورگ', flag: '🇱🇺' },
  LT: { name: 'لیتوانی', flag: '🇱🇹' },
  LV: { name: 'لتونی', flag: '🇱🇻' },
  EE: { name: 'استونی', flag: '🇪🇪' },
  IS: { name: 'ایسلند', flag: '🇮🇸' },
  ZA: { name: 'آفریقای جنوبی', flag: '🇿🇦' },
  MY: { name: 'مالزی', flag: '🇲🇾' },
  ID: { name: 'اندونزی', flag: '🇮🇩' },
  VN: { name: 'ویتنام', flag: '🇻🇳' },
  TH: { name: 'تایلند', flag: '🇹🇭' },
  PH: { name: 'فیلیپین', flag: '🇵🇭' },
  NZ: { name: 'نیوزیلند', flag: '🇳🇿' },
  AR: { name: 'آرژانتین', flag: '🇦🇷' },
  CL: { name: 'شیلی', flag: '🇨🇱' },
  CO: { name: 'کلمبیا', flag: '🇨🇴' },
  MX: { name: 'مکزیک', flag: '🇲🇽' },
};

function getFlagEmoji(countryCode: string): string {
  const codePoints = countryCode
    .toUpperCase()
    .split('')
    .map(c => 127397 + c.charCodeAt(0));
  return String.fromCodePoint(...codePoints);
}

export function resolveCountryFromCode(code?: string): CountryInfo | null {
  if (!code) return null;
  const upper = code.trim().toUpperCase();
  const info = COUNTRY_MAP[upper];
  if (info) {
    return { code: upper, name: info.name, flag: info.flag };
  }
  if (/^[A-Z]{2}$/.test(upper)) {
    return { code: upper, name: upper, flag: getFlagEmoji(upper) };
  }
  return null;
}

export function extractCountryFromName(name?: string): CountryInfo | null {
  if (!name) return null;

  // 1. Check flag emoji in name
  for (const [code, info] of Object.entries(COUNTRY_MAP)) {
    if (name.includes(info.flag)) {
      return { code, name: info.name, flag: info.flag };
    }
  }

  // 2. Check 2-letter uppercase word in name (e.g. "US", "DE", "NL", "TR")
  const words = name.split(/[\s|_-]+/);
  for (const w of words) {
    const upper = w.trim().toUpperCase();
    if (COUNTRY_MAP[upper]) {
      return { code: upper, name: COUNTRY_MAP[upper].name, flag: COUNTRY_MAP[upper].flag };
    }
  }

  return null;
}

export function getDisplayCountry(exitCountry?: string, configName?: string, provenance?: ExitCountryProvenance): string {
  const fromCode = resolveCountryFromCode(exitCountry);
  if (fromCode) {
    const provIndicator = provenance === 'inferred' ? ' (~)' : '';
    return `${fromCode.flag} ${fromCode.name}${provIndicator}`;
  }

  const fromName = extractCountryFromName(configName);
  if (fromName) {
    return `${fromName.flag} ${fromName.name}`;
  }

  return '';
}

export function normalizeCountryCode(country?: string): string | null {
  if (!country) return null;
  const trimmed = country.trim();
  const upper = trimmed.toUpperCase();
  if (COUNTRY_MAP[upper] || /^[A-Z]{2}$/.test(upper)) {
    return upper;
  }

  const fromCode = resolveCountryFromCode(trimmed);
  if (fromCode) return fromCode.code;

  const fromName = extractCountryFromName(trimmed);
  if (fromName) return fromName.code;

  for (const [code, info] of Object.entries(COUNTRY_MAP)) {
    if (info.name === trimmed || info.flag === trimmed) {
      return code;
    }
  }

  return null;
}

export interface CountryCompatibilityResult {
  compatible: boolean;
  reason?: string;
  actualCountry?: string;
  expectedCountry?: string;
  provenance: ExitCountryProvenance;
}

/**
 * Validates country compatibility with fail-closed semantics.
 * If expectedCountry is specified, only configs with 'measured' provenance matching
 * the expected country are accepted. 'inferred', 'unknown', or missing provenance is rejected.
 */
export function checkCountryCompatibility(
  configOrCountry:
    | { exitCountry?: string; exitCountryProvenance?: ExitCountryProvenance; name?: string }
    | string
    | undefined,
  expectedCountry?: string,
  provenance?: ExitCountryProvenance
): CountryCompatibilityResult {
  const country = typeof configOrCountry === 'string'
    ? configOrCountry
    : configOrCountry?.exitCountry;
  const actualProvenance: ExitCountryProvenance = (typeof configOrCountry === 'object' && configOrCountry !== null
    ? configOrCountry.exitCountryProvenance
    : provenance) ?? 'unknown';

  if (!expectedCountry) {
    return {
      compatible: true,
      actualCountry: country ? (normalizeCountryCode(country) ?? country) : undefined,
      provenance: actualProvenance,
    };
  }

  const expectedCode = normalizeCountryCode(expectedCountry);
  if (!expectedCode) {
    return {
      compatible: false,
      reason: `Invalid expected country: ${expectedCountry}`,
      actualCountry: country,
      expectedCountry,
      provenance: actualProvenance,
    };
  }

  // Fail-closed rule: unknown and inferred are strictly rejected
  if (actualProvenance !== 'measured') {
    return {
      compatible: false,
      reason: `Exit country provenance '${actualProvenance}' is not 'measured' (fail-closed policy)`,
      actualCountry: country,
      expectedCountry: expectedCode,
      provenance: actualProvenance,
    };
  }

  if (!country) {
    return {
      compatible: false,
      reason: 'Exit country is not recorded',
      expectedCountry: expectedCode,
      provenance: actualProvenance,
    };
  }

  const actualCode = normalizeCountryCode(country);
  if (actualCode !== expectedCode) {
    return {
      compatible: false,
      reason: `Measured exit country '${actualCode}' does not match expected '${expectedCode}'`,
      actualCountry: actualCode ?? country,
      expectedCountry: expectedCode,
      provenance: actualProvenance,
    };
  }

  return {
    compatible: true,
    actualCountry: actualCode,
    expectedCountry: expectedCode,
    provenance: actualProvenance,
  };
}

export function isCountryCompatible(
  configOrCountry:
    | { exitCountry?: string; exitCountryProvenance?: ExitCountryProvenance; name?: string }
    | string
    | undefined,
  expectedCountry?: string,
  provenance?: ExitCountryProvenance
): boolean {
  return checkCountryCompatibility(configOrCountry, expectedCountry, provenance).compatible;
}

export function determineExitCountryProvenance(options: {
  exitCountry?: string;
  hasMeasuredExitIp?: boolean;
  measured?: boolean;
  inferredFromName?: boolean;
  provenanceOverride?: ExitCountryProvenance;
}): ExitCountryProvenance {
  if (options.provenanceOverride) return options.provenanceOverride;
  if (options.measured || options.hasMeasuredExitIp) return 'measured';
  if (options.inferredFromName) return 'inferred';
  return 'unknown';
}

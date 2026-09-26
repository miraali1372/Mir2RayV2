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

export function getDisplayCountry(exitCountry?: string, configName?: string): string {
  const fromCode = resolveCountryFromCode(exitCountry);
  if (fromCode) {
    return `${fromCode.flag} ${fromCode.name}`;
  }

  const fromName = extractCountryFromName(configName);
  if (fromName) {
    return `${fromName.flag} ${fromName.name}`;
  }

  return '';
}

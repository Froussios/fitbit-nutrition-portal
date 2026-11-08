/**
 * Open Food Facts country tags (`countries_tags`, without the `en:` prefix) and their ISO 3166-1 alpha-2 codes.
 * Generated from the Open Food Facts country taxonomy
 * (https://static.openfoodfacts.org/data/taxonomies/countries.json, field `country_code_2`), with "UK" written
 * as "GB" and tags with no current code left out (`en:world`, `en:yugoslavia`, `en:soviet-union`...).
 * Tags missing here are ignored, so regenerate it only if Open Food Facts adds a country.
 */
export const OFF_COUNTRY_CODES: Readonly<Record<string, string>> = {
  afghanistan: "AF", "aland-islands": "AX", albania: "AL", algeria: "DZ", "american-samoa": "AS", andorra: "AD",
  angola: "AO", anguilla: "AI", antarctic: "AQ", "antigua-and-barbuda": "AG", argentina: "AR", armenia: "AM",
  aruba: "AW", australia: "AU", austria: "AT", azerbaijan: "AZ", bahrain: "BH", bangladesh: "BD", barbados: "BB",
  belarus: "BY", belgium: "BE", belize: "BZ", benin: "BJ", bermuda: "BM", bhutan: "BT", bolivia: "BO",
  "bosnia-and-herzegovina": "BA", botswana: "BW", "bouvet-island": "BV", brazil: "BR",
  "british-indian-ocean-territory": "IO", "british-virgin-islands": "VG", brunei: "BN", bulgaria: "BG",
  "burkina-faso": "BF", burundi: "BI", cambodia: "KH", cameroon: "CM", canada: "CA", "cape-verde": "CV",
  "caribbean-netherlands": "BQ", "cayman-islands": "KY", "central-african-republic": "CF", chad: "TD", chile: "CL",
  china: "CN", "christmas-island": "CX", "cocos-keeling-islands": "CC", colombia: "CO", comoros: "KM",
  "cook-islands": "CK", "costa-rica": "CR", "cote-d-ivoire": "CI", croatia: "HR", cuba: "CU", curacao: "CW",
  cyprus: "CY", "czech-republic": "CZ", "democratic-republic-of-the-congo": "CD", denmark: "DK", djibouti: "DJ",
  dominica: "DM", "dominican-republic": "DO", ecuador: "EC", egypt: "EG", "el-salvador": "SV",
  "equatorial-guinea": "GQ", eritrea: "ER", estonia: "EE", ethiopia: "ET", "falkland-islands": "FK",
  "faroe-islands": "FO", "federated-states-of-micronesia": "FM", fiji: "FJ", finland: "FI", france: "FR",
  "french-guiana": "GF", "french-polynesia": "PF", "french-southern-and-antarctic-lands": "TF", gabon: "GA",
  gambia: "GM", georgia: "GE", germany: "DE", ghana: "GH", gibraltar: "GI", greece: "GR", greenland: "GL",
  grenada: "GD", guadeloupe: "GP", guam: "GU", guatemala: "GT", guernsey: "GG", guinea: "GN", "guinea-bissau": "GW",
  guyana: "GY", haiti: "HT", "heard-island-and-mcdonald-islands": "HM", honduras: "HN", "hong-kong": "HK",
  hungary: "HU", iceland: "IS", india: "IN", indonesia: "ID", iran: "IR", iraq: "IQ", ireland: "IE",
  "isle-of-man": "IM", israel: "IL", italy: "IT", jamaica: "JM", japan: "JP", jersey: "JE", jordan: "JO",
  kazakhstan: "KZ", kenya: "KE", kiribati: "KI", kosovo: "XK", kuwait: "KW", kyrgyzstan: "KG", laos: "LA",
  latvia: "LV", lebanon: "LB", lesotho: "LS", liberia: "LR", libya: "LY", liechtenstein: "LI", lithuania: "LT",
  luxembourg: "LU", macau: "MO", madagascar: "MG", malawi: "MW", malaysia: "MY", maldives: "MV", mali: "ML",
  malta: "MT", "marshall-islands": "MH", martinique: "MQ", mauritania: "MR", mauritius: "MU", mayotte: "YT",
  mexico: "MX", moldova: "MD", monaco: "MC", mongolia: "MN", montenegro: "ME", montserrat: "MS", morocco: "MA",
  mozambique: "MZ", myanmar: "MM", namibia: "NA", nauru: "NR", nepal: "NP", netherlands: "NL", "new-caledonia": "NC",
  "new-zealand": "NZ", nicaragua: "NI", niger: "NE", nigeria: "NG", niue: "NU", "norfolk-island": "NF",
  "north-korea": "KP", "north-macedonia": "MK", "northern-mariana-islands": "MP", norway: "NO", oman: "OM",
  pakistan: "PK", palau: "PW", panama: "PA", "papua-new-guinea": "PG", paraguay: "PY", peru: "PE", philippines: "PH",
  pitcairn: "PN", poland: "PL", portugal: "PT", "puerto-rico": "PR", qatar: "QA", "republic-of-the-congo": "CG",
  reunion: "RE", romania: "RO", russia: "RU", rwanda: "RW", "saint-barthelemy": "BL", "saint-helena": "SH",
  "saint-kitts-and-nevis": "KN", "saint-lucia": "LC", "saint-martin": "MF", "saint-pierre-and-miquelon": "PM",
  "saint-vincent-and-the-grenadines": "VC", samoa: "WS", "san-marino": "SM", "sao-tome-and-principe": "ST",
  "saudi-arabia": "SA", senegal: "SN", serbia: "RS", seychelles: "SC", "sierra-leone": "SL", singapore: "SG",
  "sint-maarten": "SX", slovakia: "SK", slovenia: "SI", "solomon-islands": "SB", somalia: "SO", "south-africa": "ZA",
  "south-georgia-and-the-south-sandwich-islands": "GS", "south-korea": "KR", "south-sudan": "SS", spain: "ES",
  "sri-lanka": "LK", "state-of-palestine": "PS", sudan: "SD", suriname: "SR", "svalbard-and-jan-mayen": "SJ",
  swaziland: "SZ", sweden: "SE", switzerland: "CH", syria: "SY", taiwan: "TW", tajikistan: "TJ", tanzania: "TZ",
  thailand: "TH", "the-bahamas": "BS", "timor-leste": "TL", togo: "TG", tokelau: "TK", tonga: "TO",
  "trinidad-and-tobago": "TT", tunisia: "TN", turkey: "TR", turkmenistan: "TM", "turks-and-caicos-islands": "TC",
  tuvalu: "TV", uganda: "UG", ukraine: "UA", "united-arab-emirates": "AE", "united-kingdom": "GB",
  "united-states": "US", "united-states-minor-outlying-islands": "UM", uruguay: "UY", uzbekistan: "UZ",
  vanuatu: "VU", "vatican-city": "VA", venezuela: "VE", vietnam: "VN", "virgin-islands-of-the-united-states": "VI",
  "wallis-and-futuna": "WF", "western-sahara": "EH", yemen: "YE", zambia: "ZM", zimbabwe: "ZW",
};

/** ISO codes for an Open Food Facts `countries_tags` list, in its order, without duplicates or unknown tags. */
export function offCountries(tags: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const tag of tags ?? []) {
    const key = tag.startsWith("en:") ? tag.slice(3) : "";
    const code = Object.hasOwn(OFF_COUNTRY_CODES, key) ? OFF_COUNTRY_CODES[key] : undefined;
    if (code && !out.includes(code)) out.push(code);
  }
  return out;
}

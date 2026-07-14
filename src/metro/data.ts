/* ============================================================
   NAMMA METRO — BENGALURU
   Data layer for the schematic transit map.

   Coordinates are hand-placed schematic positions (not geo).
   Tune them visually with the Station Editor (Ctrl+Shift+D on
   the map) — it exports a diff you can bake back into this file.

   Network as of early 2026 (operational lines only):
   - Purple:  Whitefield (Kadugodi) → Challaghatta   (37 stn)
   - Green:   Madavara → Silk Institute              (32 stn)
   - Yellow:  RV Road → Bommasandra                  (16 stn)
   Interchanges: Majestic (P×G), RV Road (G×Y)
   ============================================================ */

export type LabelDir = 'top' | 'bottom' | 'left' | 'right';
export type PillOrient = 'H' | 'V';

export interface LineConfig {
  id: string;
  name: { en: string; kn: string };
  color: string;
  strokeWidth: number;
  loop: boolean;
  trainCount: number;
  /** seconds for a train to traverse the full line one way */
  duration: number;
}

export interface StationDef {
  id: string;
  en: string;
  kn: string;
  x: number;
  y: number;
  label: LabelDir;
  /** minor station — label hidden until hover, like Tokyo's local stops */
  local?: boolean;
  /** multi-line English rendering, e.g. long names split in two rows */
  enLines?: string[];
}

export type Point = [number, number];

export const LINES: LineConfig[] = [
  { id: 'purple', name: { en: 'Purple Line', kn: 'ನೇರಳೆ ಮಾರ್ಗ' }, color: '#7B2D8E', strokeWidth: 6, loop: false, trainCount: 5, duration: 130 },
  { id: 'green',  name: { en: 'Green Line',  kn: 'ಹಸಿರು ಮಾರ್ಗ' }, color: '#00A650', strokeWidth: 6, loop: false, trainCount: 4, duration: 100 },
  { id: 'yellow', name: { en: 'Yellow Line', kn: 'ಹಳದಿ ಮಾರ್ಗ' }, color: '#E8B000', strokeWidth: 6, loop: false, trainCount: 3, duration: 60 },
];

export const LINE_MAP: Record<string, LineConfig> = Object.fromEntries(LINES.map(l => [l.id, l]));

/* ═══════════════════════════════════════════════════════════
   PURPLE — 37 stations, Whitefield (Kadugodi) → Challaghatta
   Top-right horizontal → 45° SW descent → central horizontal
   spine through Majestic → 45° SW tail to Challaghatta.
   ═══════════════════════════════════════════════════════════ */

export const purpleStations: StationDef[] = [
  { id: 'whitefield',        en: 'Whitefield (Kadugodi)', kn: 'ವೈಟ್‌ಫೀಲ್ಡ್',           x: 2015, y: 250, label: 'right',  enLines: ['Whitefield', '(Kadugodi)'] },
  { id: 'hopefarm',          en: 'Hopefarm Channasandra', kn: 'ಹೋಪ್‌ಫಾರ್ಮ್ ಚನ್ನಸಂದ್ರ',  x: 1960, y: 250, label: 'top',    local: true },
  { id: 'kadugodi-park',     en: 'Kadugodi Tree Park',    kn: 'ಕಾಡುಗೋಡಿ ಟ್ರೀ ಪಾರ್ಕ್',   x: 1905, y: 250, label: 'bottom', local: true },
  { id: 'pattandur',         en: 'Pattandur Agrahara',    kn: 'ಪಟ್ಟಂದೂರು ಅಗ್ರಹಾರ',      x: 1850, y: 250, label: 'top',    local: true },
  { id: 'sathya-sai',        en: 'Sri Sathya Sai Hospital', kn: 'ಸತ್ಯ ಸಾಯಿ ಆಸ್ಪತ್ರೆ',   x: 1795, y: 250, label: 'bottom', local: true },
  { id: 'nallurhalli',       en: 'Nallurhalli',           kn: 'ನಲ್ಲೂರಹಳ್ಳಿ',            x: 1740, y: 250, label: 'top',    local: true },
  { id: 'kundalahalli',      en: 'Kundalahalli',          kn: 'ಕುಂದಲಹಳ್ಳಿ',             x: 1685, y: 250, label: 'top' },
  { id: 'seetharamapalya',   en: 'Seetharamapalya',       kn: 'ಸೀತಾರಾಮಪಾಳ್ಯ',           x: 1630, y: 250, label: 'bottom', local: true },
  { id: 'hoodi',             en: 'Hoodi',                 kn: 'ಹೂಡಿ',                   x: 1580, y: 300, label: 'right',  local: true },
  { id: 'garudacharpalya',   en: 'Garudacharpalya',       kn: 'ಗರುಡಾಚಾರ್ ಪಾಳ್ಯ',        x: 1530, y: 350, label: 'right',  local: true },
  { id: 'singayyanapalya',   en: 'Singayyanapalya',       kn: 'ಸಿಂಗಯ್ಯನಪಾಳ್ಯ',          x: 1480, y: 400, label: 'right',  local: true },
  { id: 'kr-puram',          en: 'Krishnarajapura',       kn: 'ಕೃಷ್ಣರಾಜಪುರ',            x: 1430, y: 450, label: 'right' },
  { id: 'benniganahalli',    en: 'Benniganahalli',        kn: 'ಬೆನ್ನಿಗಾನಹಳ್ಳಿ',          x: 1380, y: 500, label: 'right',  local: true },
  { id: 'baiyappanahalli',   en: 'Baiyappanahalli',       kn: 'ಬೈಯಪ್ಪನಹಳ್ಳಿ',           x: 1330, y: 550, label: 'right' },
  { id: 'sv-road',           en: 'Swami Vivekananda Road', kn: 'ವಿವೇಕಾನಂದ ರಸ್ತೆ',       x: 1280, y: 600, label: 'right',  local: true },
  { id: 'indiranagar',       en: 'Indiranagar',           kn: 'ಇಂದಿರಾನಗರ',              x: 1230, y: 650, label: 'right' },
  { id: 'halasuru',          en: 'Halasuru',              kn: 'ಹಲಸೂರು',                 x: 1180, y: 700, label: 'bottom', local: true },
  { id: 'trinity',           en: 'Trinity',               kn: 'ಟ್ರಿನಿಟಿ',               x: 1110, y: 700, label: 'top',    local: true },
  { id: 'mg-road',           en: 'MG Road',               kn: 'ಎಂ.ಜಿ. ರಸ್ತೆ',           x: 1040, y: 700, label: 'bottom' },
  { id: 'cubbon-park',       en: 'Cubbon Park',           kn: 'ಕಬ್ಬನ್ ಪಾರ್ಕ್',          x: 970,  y: 700, label: 'top' },
  { id: 'vidhana-soudha',    en: 'Vidhana Soudha',        kn: 'ವಿಧಾನ ಸೌಧ',              x: 900,  y: 700, label: 'bottom' },
  { id: 'central-college',   en: 'Central College',       kn: 'ಸೆಂಟ್ರಲ್ ಕಾಲೇಜು',        x: 830,  y: 700, label: 'top',    local: true },
  { id: 'majestic',          en: 'Majestic',              kn: 'ಮೆಜೆಸ್ಟಿಕ್',             x: 760,  y: 700, label: 'bottom' },
  { id: 'city-railway',      en: 'City Railway Station',  kn: 'ಸಿಟಿ ರೈಲ್ವೆ ನಿಲ್ದಾಣ',    x: 700,  y: 700, label: 'top',    local: true },
  { id: 'magadi-road',       en: 'Magadi Road',           kn: 'ಮಾಗಡಿ ರಸ್ತೆ',            x: 640,  y: 700, label: 'bottom', local: true },
  { id: 'hosahalli',         en: 'Hosahalli',             kn: 'ಹೊಸಹಳ್ಳಿ',               x: 580,  y: 700, label: 'top',    local: true },
  { id: 'vijayanagar',       en: 'Vijayanagar',           kn: 'ವಿಜಯನಗರ',                x: 520,  y: 700, label: 'bottom' },
  { id: 'attiguppe',         en: 'Attiguppe',             kn: 'ಅತ್ತಿಗುಪ್ಪೆ',            x: 460,  y: 700, label: 'top',    local: true },
  { id: 'deepanjali-nagar',  en: 'Deepanjali Nagar',      kn: 'ದೀಪಾಂಜಲಿ ನಗರ',           x: 400,  y: 700, label: 'bottom', local: true },
  { id: 'mysore-road',       en: 'Mysore Road',           kn: 'ಮೈಸೂರು ರಸ್ತೆ',           x: 340,  y: 700, label: 'top' },
  { id: 'nayandahalli',      en: 'Nayandahalli',          kn: 'ನಾಯಂಡಹಳ್ಳಿ',             x: 295,  y: 745, label: 'left',   local: true },
  { id: 'rr-nagar',          en: 'Rajarajeshwari Nagar',  kn: 'ರಾಜರಾಜೇಶ್ವರಿ ನಗರ',       x: 250,  y: 790, label: 'left',   local: true },
  { id: 'jnanabharathi',     en: 'Jnanabharathi',         kn: 'ಜ್ಞಾನಭಾರತಿ',             x: 205,  y: 835, label: 'left',   local: true },
  { id: 'pattanagere',       en: 'Pattanagere',           kn: 'ಪಟ್ಟಣಗೆರೆ',              x: 160,  y: 880, label: 'left',   local: true },
  { id: 'kengeri-bus',       en: 'Kengeri Bus Terminal',  kn: 'ಕೆಂಗೇರಿ ಬಸ್ ನಿಲ್ದಾಣ',   x: 115,  y: 925, label: 'left',   local: true },
  { id: 'kengeri',           en: 'Kengeri',               kn: 'ಕೆಂಗೇರಿ',                x: 70,   y: 970, label: 'left' },
  { id: 'challaghatta',      en: 'Challaghatta',          kn: 'ಚಲ್ಲಘಟ್ಟ',               x: 25,   y: 1015, label: 'left' },
];

export const purplePoints: Point[] = [
  [2015, 250], [1960, 250], [1905, 250], [1850, 250], [1795, 250], [1740, 250], [1685, 250], [1630, 250],
  [1580, 300], [1530, 350], [1480, 400], [1430, 450], [1380, 500], [1330, 550], [1280, 600], [1230, 650], [1180, 700],
  [1110, 700], [1040, 700], [970, 700], [900, 700], [830, 700], [760, 700],
  [700, 700], [640, 700], [580, 700], [520, 700], [460, 700], [400, 700], [340, 700],
  [295, 745], [250, 790], [205, 835], [160, 880], [115, 925], [70, 970], [25, 1015],
];

/* ═══════════════════════════════════════════════════════════
   GREEN — 32 stations, Madavara → Silk Institute
   NW 45° descent along Tumkur Road → east jog through
   Yeshwanthpur → vertical spine through Majestic → 45° SW
   tail down Kanakapura Road.
   ═══════════════════════════════════════════════════════════ */

export const greenStations: StationDef[] = [
  { id: 'madavara',          en: 'Madavara',              kn: 'ಮಾದಾವರ',                x: 120, y: 60,   label: 'right' },
  { id: 'chikkabidarakallu', en: 'Chikkabidarakallu',     kn: 'ಚಿಕ್ಕಬಿದರಕಲ್ಲು',        x: 165, y: 105,  label: 'left',   local: true },
  { id: 'manjunathanagara',  en: 'Manjunathanagara',      kn: 'ಮಂಜುನಾಥನಗರ',            x: 210, y: 150,  label: 'left',   local: true },
  { id: 'nagasandra',        en: 'Nagasandra',            kn: 'ನಾಗಸಂದ್ರ',              x: 255, y: 195,  label: 'left' },
  { id: 'dasarahalli',       en: 'Dasarahalli',           kn: 'ದಾಸರಹಳ್ಳಿ',             x: 300, y: 240,  label: 'left',   local: true },
  { id: 'jalahalli',         en: 'Jalahalli',             kn: 'ಜಾಲಹಳ್ಳಿ',              x: 345, y: 285,  label: 'left',   local: true },
  { id: 'peenya-industry',   en: 'Peenya Industry',       kn: 'ಪೀಣ್ಯ ಇಂಡಸ್ಟ್ರಿ',       x: 390, y: 330,  label: 'left',   local: true },
  { id: 'peenya',            en: 'Peenya',                kn: 'ಪೀಣ್ಯ',                 x: 435, y: 375,  label: 'left' },
  { id: 'goraguntepalya',    en: 'Goraguntepalya',        kn: 'ಗೊರಗುಂಟೆಪಾಳ್ಯ',         x: 480, y: 420,  label: 'bottom', local: true },
  { id: 'yeshwanthpur',      en: 'Yeshwanthpur',          kn: 'ಯಶವಂತಪುರ',              x: 545, y: 420,  label: 'top' },
  { id: 'sandal-soap',       en: 'Sandal Soap Factory',   kn: 'ಸ್ಯಾಂಡಲ್ ಸೋಪ್ ಫ್ಯಾಕ್ಟರಿ', x: 610, y: 420, label: 'bottom', local: true },
  { id: 'mahalakshmi',       en: 'Mahalakshmi',           kn: 'ಮಹಾಲಕ್ಷ್ಮಿ',            x: 675, y: 420,  label: 'top',    local: true },
  { id: 'rajajinagar',       en: 'Rajajinagar',           kn: 'ರಾಜಾಜಿನಗರ',             x: 760, y: 475,  label: 'left' },
  { id: 'kuvempu-road',      en: 'Mahakavi Kuvempu Road', kn: 'ಕುವೆಂಪು ರಸ್ತೆ',         x: 760, y: 530,  label: 'left',   local: true },
  { id: 'srirampura',        en: 'Srirampura',            kn: 'ಶ್ರೀರಾಂಪುರ',            x: 760, y: 585,  label: 'left',   local: true },
  { id: 'sampige-road',      en: 'Sampige Road',          kn: 'ಸಂಪಿಗೆ ರಸ್ತೆ',          x: 760, y: 640,  label: 'left' },
  { id: 'majestic',          en: 'Majestic',              kn: 'ಮೆಜೆಸ್ಟಿಕ್',            x: 760, y: 700,  label: 'bottom' },
  { id: 'chickpete',         en: 'Chickpete',             kn: 'ಚಿಕ್ಕಪೇಟೆ',             x: 760, y: 755,  label: 'right' },
  { id: 'kr-market',         en: 'KR Market',             kn: 'ಕೆ.ಆರ್. ಮಾರುಕಟ್ಟೆ',     x: 760, y: 810,  label: 'right' },
  { id: 'national-college',  en: 'National College',      kn: 'ನ್ಯಾಷನಲ್ ಕಾಲೇಜು',       x: 760, y: 865,  label: 'right',  local: true },
  { id: 'lalbagh',           en: 'Lalbagh',               kn: 'ಲಾಲ್‌ಬಾಗ್',             x: 760, y: 920,  label: 'right' },
  { id: 'south-end',         en: 'South End Circle',      kn: 'ಸೌತ್ ಎಂಡ್ ಸರ್ಕಲ್',      x: 760, y: 975,  label: 'right',  local: true },
  { id: 'jayanagar',         en: 'Jayanagar',             kn: 'ಜಯನಗರ',                 x: 760, y: 1030, label: 'right' },
  { id: 'rv-road',           en: 'RV Road',               kn: 'ಆರ್.ವಿ. ರಸ್ತೆ',         x: 760, y: 1085, label: 'left' },
  { id: 'banashankari',      en: 'Banashankari',          kn: 'ಬನಶಂಕರಿ',               x: 715, y: 1130, label: 'left' },
  { id: 'jp-nagar',          en: 'JP Nagar',              kn: 'ಜೆ.ಪಿ. ನಗರ',            x: 670, y: 1175, label: 'left',   local: true },
  { id: 'yelachenahalli',    en: 'Yelachenahalli',        kn: 'ಯಲಚೇನಹಳ್ಳಿ',            x: 625, y: 1220, label: 'left' },
  { id: 'konanakunte',       en: 'Konanakunte Cross',     kn: 'ಕೋಣನಕುಂಟೆ ಕ್ರಾಸ್',      x: 580, y: 1265, label: 'left',   local: true },
  { id: 'doddakallasandra',  en: 'Doddakallasandra',      kn: 'ದೊಡ್ಡಕಲ್ಲಸಂದ್ರ',        x: 535, y: 1310, label: 'left',   local: true },
  { id: 'vajarahalli',       en: 'Vajarahalli',           kn: 'ವಜರಹಳ್ಳಿ',              x: 490, y: 1355, label: 'left',   local: true },
  { id: 'thalaghattapura',   en: 'Thalaghattapura',       kn: 'ತಲಘಟ್ಟಪುರ',             x: 445, y: 1400, label: 'left',   local: true },
  { id: 'silk-institute',    en: 'Silk Institute',        kn: 'ರೇಷ್ಮೆ ಸಂಸ್ಥೆ',         x: 400, y: 1445, label: 'left' },
];

export const greenPoints: Point[] = [
  [120, 60], [165, 105], [210, 150], [255, 195], [300, 240], [345, 285], [390, 330], [435, 375], [480, 420],
  [545, 420], [610, 420], [675, 420],
  [760, 475], [760, 530], [760, 585], [760, 640], [760, 700],
  [760, 755], [760, 810], [760, 865], [760, 920], [760, 975], [760, 1030], [760, 1085],
  [715, 1130], [670, 1175], [625, 1220], [580, 1265], [535, 1310], [490, 1355], [445, 1400], [400, 1445],
];

/* ═══════════════════════════════════════════════════════════
   YELLOW — 16 stations, RV Road → Bommasandra
   East along the Outer Ring Road corridor → 45° SE down
   Hosur Road → vertical tail to Bommasandra.
   ═══════════════════════════════════════════════════════════ */

export const yellowStations: StationDef[] = [
  { id: 'rv-road',           en: 'RV Road',               kn: 'ಆರ್.ವಿ. ರಸ್ತೆ',         x: 760,  y: 1085, label: 'left' },
  { id: 'ragigudda',         en: 'Ragigudda',             kn: 'ರಾಗಿಗುಡ್ಡ',             x: 830,  y: 1085, label: 'bottom', local: true },
  { id: 'jayadeva',          en: 'Jayadeva Hospital',     kn: 'ಜಯದೇವ ಆಸ್ಪತ್ರೆ',        x: 900,  y: 1085, label: 'top' },
  { id: 'btm-layout',        en: 'BTM Layout',            kn: 'ಬಿ.ಟಿ.ಎಂ. ಲೇಔಟ್',       x: 970,  y: 1085, label: 'bottom' },
  { id: 'silk-board',        en: 'Central Silk Board',    kn: 'ಸಿಲ್ಕ್ ಬೋರ್ಡ್',         x: 1040, y: 1085, label: 'top' },
  { id: 'bommanahalli',      en: 'Bommanahalli',          kn: 'ಬೊಮ್ಮನಹಳ್ಳಿ',           x: 1090, y: 1135, label: 'right',  local: true },
  { id: 'hongasandra',       en: 'Hongasandra',           kn: 'ಹೊಂಗಸಂದ್ರ',             x: 1140, y: 1185, label: 'right',  local: true },
  { id: 'kudlu-gate',        en: 'Kudlu Gate',            kn: 'ಕೂಡ್ಲು ಗೇಟ್',           x: 1190, y: 1235, label: 'right',  local: true },
  { id: 'singasandra',       en: 'Singasandra',           kn: 'ಸಿಂಗಸಂದ್ರ',             x: 1240, y: 1285, label: 'right',  local: true },
  { id: 'hosa-road',         en: 'Hosa Road',             kn: 'ಹೊಸ ರಸ್ತೆ',             x: 1240, y: 1340, label: 'right',  local: true },
  { id: 'beratena',          en: 'Beratena Agrahara',     kn: 'ಬೆರಟೇನ ಅಗ್ರಹಾರ',        x: 1240, y: 1395, label: 'right',  local: true },
  { id: 'electronic-city',   en: 'Electronic City',       kn: 'ಎಲೆಕ್ಟ್ರಾನಿಕ್ ಸಿಟಿ',    x: 1240, y: 1450, label: 'right' },
  { id: 'konappana',         en: 'Konappana Agrahara',    kn: 'ಕೋಣಪ್ಪನ ಅಗ್ರಹಾರ',       x: 1240, y: 1505, label: 'right',  local: true },
  { id: 'huskur-road',       en: 'Huskur Road',           kn: 'ಹುಸ್ಕೂರು ರಸ್ತೆ',        x: 1240, y: 1560, label: 'right',  local: true },
  { id: 'hebbagodi',         en: 'Hebbagodi',             kn: 'ಹೆಬ್ಬಗೋಡಿ',             x: 1240, y: 1615, label: 'right',  local: true },
  { id: 'bommasandra',       en: 'Bommasandra',           kn: 'ಬೊಮ್ಮಸಂದ್ರ',            x: 1240, y: 1670, label: 'right' },
];

export const yellowPoints: Point[] = [
  [760, 1085], [830, 1085], [900, 1085], [970, 1085], [1040, 1085],
  [1090, 1135], [1140, 1185], [1190, 1235], [1240, 1285],
  [1240, 1340], [1240, 1395], [1240, 1450], [1240, 1505], [1240, 1560], [1240, 1615], [1240, 1670],
];

/* ═══════════════════════════════════════════════════════════
   REGISTRY — stations shared across lines merge by id
   ═══════════════════════════════════════════════════════════ */

export interface Station extends StationDef {
  lines: Set<string>;
}

export interface LineData {
  cfg: LineConfig;
  stations: StationDef[];
  points: Point[];
}

export const lineData: LineData[] = [
  { cfg: LINES[0], stations: purpleStations, points: purplePoints },
  { cfg: LINES[1], stations: greenStations,  points: greenPoints },
  { cfg: LINES[2], stations: yellowStations, points: yellowPoints },
];

export function buildStationMap(): Map<string, Station> {
  const map = new Map<string, Station>();
  lineData.forEach(ld => {
    ld.stations.forEach(s => {
      const existing = map.get(s.id);
      if (existing) {
        existing.lines.add(ld.cfg.id);
        if (!s.local) existing.local = false;
      } else {
        map.set(s.id, { ...s, lines: new Set([ld.cfg.id]) });
      }
    });
  });
  return map;
}

/** Baked-in pill orientations for interchanges (editable in the Station Editor). */
export const ORIENT_DEFAULTS: Record<string, PillOrient> = {
  'majestic': 'H',
  'rv-road': 'V',
};

/** Map centre used for the initial "reset" framing. */
export const MAP_CX = 1020;
export const MAP_CY = 860;

export const LEGEND_FOOTER = '83 stn · 2 xch · ~96 km';

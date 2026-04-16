/**
 * IATA → ICAO airport code mapping.
 * Used to query AviationWeather (NOAA) METAR API which requires ICAO codes.
 * Coverage: Taiwan, East Asia, Southeast Asia, Middle East, Europe, US majors.
 */
const IATA_TO_ICAO_AIRPORT = {
  // Taiwan
  TPE: 'RCTP', TSA: 'RCSS', KHH: 'RCKH', RMQ: 'RCMQ',
  TNN: 'RCNN', TTT: 'RCFN', HUN: 'RCYU', GNI: 'RCGI',
  // Japan
  NRT: 'RJAA', HND: 'RJTT', KIX: 'RJBB', ITM: 'RJOO',
  NGO: 'RJGG', CTS: 'RJCC', FUK: 'RJFF', OKA: 'ROAH',
  OSA: 'RJBB', SPK: 'RJCC', HIJ: 'RJOA', KOJ: 'RJFK',
  // Korea
  ICN: 'RKSI', GMP: 'RKSS', PUS: 'RKPK', CJU: 'RKPC',
  TAE: 'RKTN', CJJ: 'RKTU',
  // China
  PEK: 'ZBAA', PKX: 'ZBAD', PVG: 'ZSPD', SHA: 'ZSSS',
  CAN: 'ZGGG', SZX: 'ZGSZ', CTU: 'ZUUU', XIY: 'ZLXY',
  WUH: 'ZHHH', NKG: 'ZSNJ', HGH: 'ZSHC', TAO: 'ZSQD',
  XMN: 'ZSAM', CSX: 'ZGHA', KMG: 'ZPPP', URC: 'ZWWW',
  HRB: 'ZYHB', SHE: 'ZYTX', DLC: 'ZYTL', TNA: 'ZSJN',
  // Hong Kong / Macau
  HKG: 'VHHH', MFM: 'VMMC',
  // Southeast Asia
  BKK: 'VTBS', DMK: 'VTBD', HKT: 'VTSP', CNX: 'VTCC',
  SIN: 'WSSS', KUL: 'WMKK', PEN: 'WMKP', LGK: 'WMKL',
  MNL: 'RPLL', CEB: 'RPVM', DVO: 'RPMD',
  CGK: 'WIII', DPS: 'WADD', SUB: 'WARR', JOG: 'WARJ',
  SGN: 'VVTS', HAN: 'VVNB', DAD: 'VVDN',
  BKI: 'WBKK', KCH: 'WBGG',
  RGN: 'VYYY',
  // India
  DEL: 'VIDP', BOM: 'VABB', BLR: 'VOBL', MAA: 'VOMM',
  HYD: 'VOHS', CCU: 'VECC',
  // Middle East
  DXB: 'OMDB', AUH: 'OMAA', SHJ: 'OMSJ',
  DOH: 'OTHH', BAH: 'OBBI', KWI: 'OKBK',
  AMM: 'OJAI', BEY: 'OLBA', RUH: 'OERK', JED: 'OEJN',
  TLV: 'LLBG', MCT: 'OOMS',
  // Turkey
  IST: 'LTFM', SAW: 'LTFJ', ESB: 'LTAC', AYT: 'LTAI',
  // Europe
  LHR: 'EGLL', LGW: 'EGKK', MAN: 'EGCC', EDI: 'EGPH',
  CDG: 'LFPG', ORY: 'LFPO', NCE: 'LFMN', LYS: 'LFLL',
  FRA: 'EDDF', MUC: 'EDDM', BER: 'EDDB', HAM: 'EDDH',
  AMS: 'EHAM', BRU: 'EBBR',
  MAD: 'LEMD', BCN: 'LEBL', VLC: 'LEVC', PMI: 'LEPA',
  FCO: 'LIRF', MXP: 'LIMC', VCE: 'LIPZ', NAP: 'LIRN',
  ZRH: 'LSZH', GVA: 'LSGG',
  VIE: 'LOWW', PRG: 'LKPR', BUD: 'LHBP', WAW: 'EPWA',
  CPH: 'EKCH', ARN: 'ESSA', OSL: 'ENGM', HEL: 'EFHK',
  ATH: 'LGAV', LIS: 'LPPT', OPO: 'LPPR',
  DUB: 'EIDW', SVO: 'UUEE', DME: 'UUDD', LED: 'ULLI',
  // North America
  JFK: 'KJFK', EWR: 'KEWR', LGA: 'KLGA', BOS: 'KBOS',
  LAX: 'KLAX', SFO: 'KSFO', SJC: 'KSJC', SEA: 'KSEA',
  ORD: 'KORD', MDW: 'KMDW', DFW: 'KDFW', IAH: 'KIAH',
  ATL: 'KATL', MIA: 'KMIA', MCO: 'KMCO', TPA: 'KTPA',
  DEN: 'KDEN', PHX: 'KPHX', LAS: 'KLAS', SLC: 'KSLC',
  IAD: 'KIAD', DCA: 'KDCA', BWI: 'KBWI',
  YYZ: 'CYYZ', YVR: 'CYVR', YUL: 'CYUL', YYC: 'CYYC',
  MEX: 'MMMX',
  // Australia / NZ
  SYD: 'YSSY', MEL: 'YMML', BNE: 'YBBN', PER: 'YPPH',
  ADL: 'YPAD', AKL: 'NZAA', CHC: 'NZCH',
};

/** Convert IATA airport code to ICAO. Returns null if unknown. */
function iataToIcaoAirport(iata) {
  if (!iata) return null;
  return IATA_TO_ICAO_AIRPORT[iata.toUpperCase()] || null;
}

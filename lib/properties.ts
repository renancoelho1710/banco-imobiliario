export type PropertyColorGroup =
  | "laranja"
  | "rosa"
  | "violeta"
  | "verdeAgua"
  | "verde"
  | "vermelho"
  | "amarelo"
  | "roxo"
  | "azulEscuro";

export type PropertyDef = {
  id: string;
  name: string;
  colorGroup: PropertyColorGroup;
  colorHex: string;
  ownerUid: "BANK" | string;

  mortgage: number;

  rentBase?: number;
  rentHouses?: number[];
  hotel?: number;

  housePrice?: number;
  hotelPrice?: number;
  sellPrice?: number;

  specialType?: "DICE_MULTIPLIER";
  multiplierValue?: number;
};

const COLORS: Record<PropertyColorGroup, string> = {
  laranja: "#F59E0B",
  rosa: "#EC4899",
  violeta: "#2563EB",
  verdeAgua: "#14B8A6",
  verde: "#22C55E",
  vermelho: "#EF4444",
  amarelo: "#EAB308",
  roxo: "#7C3AED",
  azulEscuro: "#0F172A",
};

export const INITIAL_PROPERTIES: PropertyDef[] = [
  { id: "p01", name: "PRAÇA DOS TRÊS PODERES", colorGroup: "laranja", colorHex: COLORS.laranja, ownerUid: "BANK",
    mortgage: 320000, rentBase: 26000, rentHouses: [130000, 390000, 900000, 1100000], hotel: 1275000, housePrice: 200000, hotelPrice: 200000, sellPrice: 150000 },
  { id: "p02", name: "PRAÇA CASTRO ALVES", colorGroup: "laranja", colorHex: COLORS.laranja, ownerUid: "BANK",
    mortgage: 300000, rentBase: 26000, rentHouses: [130000, 390000, 900000, 1100000], hotel: 1275000, housePrice: 200000, hotelPrice: 200000, sellPrice: 150000 },
  { id: "p03", name: "AV. DO CONTORNO", colorGroup: "laranja", colorHex: COLORS.laranja, ownerUid: "BANK",
    mortgage: 300000, rentBase: 26000, rentHouses: [130000, 390000, 900000, 1100000], hotel: 1275000, housePrice: 200000, hotelPrice: 200000, sellPrice: 150000 },

  { id: "p04", name: "JARDINS", colorGroup: "rosa", colorHex: COLORS.rosa, ownerUid: "BANK",
    mortgage: 350000, rentBase: 35000, rentHouses: [175000, 500000, 1100000, 1300000], hotel: 1500000, housePrice: 200000, hotelPrice: 200000, sellPrice: 200000 },
  { id: "p05", name: "HIGIENÓPOLIS", colorGroup: "rosa", colorHex: COLORS.rosa, ownerUid: "BANK",
    mortgage: 400000, rentBase: 50000, rentHouses: [200000, 600000, 1400000, 1700000], hotel: 2000000, housePrice: 200000, hotelPrice: 200000, sellPrice: 175000 },

  { id: "p06", name: "VIADUTO DO CHÁ", colorGroup: "violeta", colorHex: COLORS.violeta, ownerUid: "BANK",
    mortgage: 180000, rentBase: 16000, rentHouses: [80000, 220000, 600000, 800000], hotel: 1000000, housePrice: 100000, hotelPrice: 100000, sellPrice: 100000 },
  { id: "p07", name: "RUA DA CONSOLAÇÃO", colorGroup: "violeta", colorHex: COLORS.violeta, ownerUid: "BANK",
    mortgage: 180000, rentBase: 14000, rentHouses: [70000, 200000, 550000, 750000], hotel: 950000, housePrice: 100000, hotelPrice: 100000, sellPrice: 100000 },
  { id: "p08", name: "PRAÇA DA SÉ", colorGroup: "violeta", colorHex: COLORS.violeta, ownerUid: "BANK",
    mortgage: 200000, rentBase: 14000, rentHouses: [70000, 200000, 550000, 750000], hotel: 950000, housePrice: 100000, hotelPrice: 100000, sellPrice: 100000},
  // VERDE ÁGUA
  {
    id: "p09",
    name: "PONTE DO GUAÍBA",
    colorGroup: "verdeAgua",
    colorHex: COLORS.verdeAgua,
    ownerUid: "BANK",
    mortgage: 140000,
    rentBase: 10000,
    rentHouses: [50000, 150000, 450000, 625000],
    hotel: 750000,
    housePrice: 100000,
    hotelPrice: 100000,
    sellPrice: 70000,
  },
  {
    id: "p10",
    name: "AV. RECIFE",
    colorGroup: "verdeAgua",
    colorHex: COLORS.verdeAgua,
    ownerUid: "BANK",
    mortgage: 140000,
    rentBase: 10000,
    rentHouses: [50000, 150000, 450000, 625000],
    hotel: 750000,
    housePrice: 100000,
    hotelPrice: 100000,
    sellPrice: 70000,
  },
  {
    id: "p11",
    name: "AV. PAULISTA",
    colorGroup: "verdeAgua",
    colorHex: COLORS.verdeAgua,
    ownerUid: "BANK",
    mortgage: 140000,
    rentBase: 12000,
    rentHouses: [60000, 180000, 500000, 700000],
    hotel: 900000,
    housePrice: 100000,
    hotelPrice: 100000,
    sellPrice: 80000,
  },

  // VERDE
  {
    id: "p12",
    name: "AV. BEIRA MAR",
    colorGroup: "verde",
    colorHex: COLORS.verde,
    ownerUid: "BANK",
    mortgage: 60000,
    rentBase: 6000,
    rentHouses: [30000, 90000, 270000, 400000],
    hotel: 500000,
    housePrice: 50000,
    hotelPrice: 50000,
    sellPrice: 50000,
  },
  {
    id: "p13",
    name: "AV. NIEMEYER",
    colorGroup: "verde",
    colorHex: COLORS.verde,
    ownerUid: "BANK",
    mortgage: 75000,
    rentBase: 2000,
    rentHouses: [10000, 30000, 90000, 160000],
    hotel: 250000,
    housePrice: 50000,
    hotelPrice: 50000,
    sellPrice: 50000,
  },
  {
    id: "p14",
    name: "JD. BOTÂNICO",
    colorGroup: "verde",
    colorHex: COLORS.verde,
    ownerUid: "BANK",
    mortgage: 100000,
    rentBase: 4000,
    rentHouses: [20000, 60000, 180000, 320000],
    hotel: 450000,
    housePrice: 50000,
    hotelPrice: 50000,
    sellPrice: 50000,
  },

  // VERMELHO
  {
    id: "p15",
    name: "AV. IBIRAPUERA",
    colorGroup: "vermelho",
    colorHex: COLORS.vermelho,
    ownerUid: "BANK",
    mortgage: 220000,
    rentBase: 18000,
    rentHouses: [90000, 250000, 700000, 875000],
    hotel: 1050000,
    housePrice: 150000,
    hotelPrice: 150000,
    sellPrice: 110000,
  },
  {
    id: "p16",
    name: "RUA OSCAR FREIRE",
    colorGroup: "vermelho",
    colorHex: COLORS.vermelho,
    ownerUid: "BANK",
    mortgage: 220000,
    rentBase: 20000,
    rentHouses: [100000, 300000, 750000, 925000],
    hotel: 1100000,
    housePrice: 150000,
    hotelPrice: 150000,
    sellPrice: 120000,
  },
  {
    id: "p17",
    name: "AV. JUSCELINO KUBITSCHEK",
    colorGroup: "vermelho",
    colorHex: COLORS.vermelho,
    ownerUid: "BANK",
    mortgage: 240000,
    rentBase: 18000,
    rentHouses: [90000, 250000, 700000, 875000],
    hotel: 1050000,
    housePrice: 150000,
    hotelPrice: 150000,
    sellPrice: 110000,
  },

  // AMARELO
  {
    id: "p18",
    name: "PONTE RIO-NITERÓI",
    colorGroup: "amarelo",
    colorHex: COLORS.amarelo,
    ownerUid: "BANK",
    mortgage: 280000,
    rentBase: 22000,
    rentHouses: [110000, 330000, 800000, 975000],
    hotel: 1150000,
    housePrice: 150000,
    hotelPrice: 150000,
    sellPrice: 130000,
  },
  {
    id: "p19",
    name: "BARRA DA TIJUCA",
    colorGroup: "amarelo",
    colorHex: COLORS.amarelo,
    ownerUid: "BANK",
    mortgage: 260000,
    rentBase: 22000,
    rentHouses: [110000, 330000, 800000, 975000],
    hotel: 1150000,
    housePrice: 150000,
    hotelPrice: 150000,
    sellPrice: 130000,
  },
  {
    id: "p20",
    name: "MARINA DA GLÓRIA",
    colorGroup: "amarelo",
    colorHex: COLORS.amarelo,
    ownerUid: "BANK",
    mortgage: 260000,
    rentBase: 26000,
    rentHouses: [130000, 360000, 850000, 1025000],
    hotel: 1200000,
    housePrice: 150000,
    hotelPrice: 150000,
    sellPrice: 140000,
  },

  // ROXO
  {
    id: "p21",
    name: "AV. SÃO JOÃO",
    colorGroup: "roxo",
    colorHex: COLORS.roxo,
    ownerUid: "BANK",
    mortgage: 120000,
    rentBase: 8000,
    rentHouses: [40000, 100000, 300000, 450000],
    hotel: 600000,
    housePrice: 50000,
    hotelPrice: 50000,
    sellPrice: 60000,
  },
  {
    id: "p22",
    name: "AV. IPIRANGA",
    colorGroup: "roxo",
    colorHex: COLORS.roxo,
    ownerUid: "BANK",
    mortgage: 100000,
    rentBase: 6000,
    rentHouses: [30000, 90000, 270000, 400000],
    hotel: 500000,
    housePrice: 50000,
    hotelPrice: 50000,
    sellPrice: 50000,
  },

  // AZUL ESCURO (ESPECIAIS - multiplicador)
  {
    id: "p23",
    name: "COMPANHIA PETROLÍFERA",
    colorGroup: "azulEscuro",
    colorHex: COLORS.azulEscuro,
    ownerUid: "BANK",
    mortgage: 200000,
    specialType: "DICE_MULTIPLIER",
    multiplierValue: 50000,
    sellPrice: 100000,
  },
  {
    id: "p24",
    name: "COMPANHIA DE ÁGUA E SANEAMENTO",
    colorGroup: "azulEscuro",
    colorHex: COLORS.azulEscuro,
    ownerUid: "BANK",
    mortgage: 200000,
    specialType: "DICE_MULTIPLIER",
    multiplierValue: 50000,
    sellPrice: 100000,
  },
  {
    id: "p25",
    name: "PONTOCOM",
    colorGroup: "azulEscuro",
    colorHex: COLORS.azulEscuro,
    ownerUid: "BANK",
    mortgage: 150000,
    specialType: "DICE_MULTIPLIER",
    multiplierValue: 40000,
    sellPrice: 75000,
  },
  {
    id: "p26",
    name: "CRÉDITOS DE CARBONO",
    colorGroup: "azulEscuro",
    colorHex: COLORS.azulEscuro,
    ownerUid: "BANK",
    mortgage: 150000,
    specialType: "DICE_MULTIPLIER",
    multiplierValue: 40000,
    sellPrice: 75000,
  },
  {
    id: "p27",
    name: "CENTRAL DE FORÇA E LUZ",
    colorGroup: "azulEscuro",
    colorHex: COLORS.azulEscuro,
    ownerUid: "BANK",
    mortgage: 200000,
    specialType: "DICE_MULTIPLIER",
    multiplierValue: 50000,
    sellPrice: 100000,
  },
  {
    id: "p28",
    name: "COMPANHIA DE MINERAÇÃO",
    colorGroup: "azulEscuro",
    colorHex: COLORS.azulEscuro,
    ownerUid: "BANK",
    mortgage: 200000,
    specialType: "DICE_MULTIPLIER",
    multiplierValue: 50000,
    sellPrice: 100000,
  },
];

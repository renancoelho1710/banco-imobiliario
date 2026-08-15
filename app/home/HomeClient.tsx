'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { signInWithEmailAndPassword } from 'firebase/auth';
import { auth } from '@/lib/firebase';
import * as QRCode from 'qrcode';
import { BrowserMultiFormatReader } from '@zxing/browser';
import { onValue, ref, runTransaction, set, update, push, get } from 'firebase/database';
import { db } from '@/lib/firebase';

/* ================= TIPOS ================= */

type Role = 'jogador' | 'bancario';
type PlayerStatus = 'ativo' | 'preso' | 'falido' | 'desistente' | 'vencedor';

type LedgerItem = {
  id: string;
  at: number;
  title: string;
  amount: number; // + entra / - sai (para QUEM está vendo)
  kind: 'pago' | 'recebido' | 'compra' | 'venda' | 'bonus' | 'taxa' | 'ajuste' | 'aluguel' | 'fiança';
  from?: string;
  to?: string;
  meta?: any;
  viewerUid?: string; // quem "enxerga"
};

type PropertyItem = {
  id: string;
  name: string;
  colorName: string;
  colorHex: string;

  kind: 'NORMAL' | 'MULTIPLIER'; // azul escuro especial
  price: number; // hipoteca (pra comprar com banco)

  baseRent?: number; // aluguel sem casa
  rentByHouses?: { [k: number]: number }; // 1..4
  hotel?: number;

  multiplierValue?: number; // valor por ponto do dado (caso MULTIPLIER)

  houseCost?: number;
  hotelCost?: number;
  sellValue: number;

  ownerUid: string; // "BANK" ou uid do jogador
  houses: 0 | 1 | 2 | 3 | 4;
  hasHotel: boolean;
  mortgaged: boolean;
};

type SaleStatus = 'pending_payment' | 'paid_full' | 'transferred' | 'cancelled';

type SaleDoc = {
  id: string;
  at: number;

  roomCode: string;

  propId: string;
  propName: string;

  buyerUid: string;
  buyerName: string;

  total: number;

  mode: 'avista' | 'parcelado';
  installments: number; // 1..6
  paidInstallments: boolean[]; // tamanho = installments
  paidCount: number;

  status: SaleStatus;
  paymentMethod?: 'pix' | 'cash' | 'bank_transfer';

  // opcional: venda entre jogadores
  fromUid?: string;
  fromName?: string;
};

type TransferStatus = 'pending_payment' | 'paid' | 'transferred' | 'cancelled';

type TransferDoc = {
  id: string;
  at: number;
  roomCode: string;

  propId: string;
  propName: string;

  fromUid: string;
  fromName: string;

  toUid: string;
  toName: string;

  amount: number;

  status: TransferStatus;
  paymentMethod?: 'pix' | 'cash' | 'bank_transfer';
};

type BankerNotification =
  | { type: 'SALE_PAID'; saleId: string; at: number }
  | { type: 'BAIL_PAID'; prisonerUid: string; at: number }
  | { type: 'TRANSFER_PAID'; transferId: string; at: number };

type RoomState = {
  roomCode: string;
  bankerUid: string;

  settings: { startBonus: number; bail: number };

  players: Record<
    string,
    {
      uid: string;
      name: string;
      role: Role;
      status: PlayerStatus;
      balance: number;
      debtToBank: number;
      online?: boolean;
      lastSeen?: number;
    }
  >;

  properties: PropertyItem[];
};

type QrPayload = {
  v: 1;
  room: string;
  paymentId: string; // id único: impede o mesmo Pix/QR de ser pago duas vezes

  kind: 'TRANSFER' | 'BUY_INSTALLMENT';

  toUid: string; // recebedor do dinheiro
  toName: string;

  amount: number;
  title: string;
  createdAt: number;

  meta?: any;
};

/* ================= UTIL ================= */

const START_BALANCE = 2558000;
const BANK_UID = 'BANK';
const BANK_NAME = 'BANCO';
const BANK_BALANCE = 999999999;
const BAIL_AMOUNT = 50000;

function idNow() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
function money(n: number) {
  const v = Math.round(n);
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function parseMoneyBRL(text: string) {
  // aceita "12", "12,50", "R$ 12,50", "1.234,56"
  const cleaned = (text || '')
    .replace(/[^\d,.-]/g, '')
    .replace(/\./g, '')
    .replace(',', '.');

  const n = Number(cleaned);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
}

function parseMoneyTyping(text: string) {
  // Durante a digitação tratamos os dígitos como reais inteiros.
  // Ex.: 10 -> R$ 10 | 100000 -> R$ 100.000.
  const digits = (text || '').replace(/\D/g, '');
  if (!digits) return 0;
  const n = Number(digits.slice(0, 12));
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function moneyTyping(n: number) {
  const v = Math.max(0, Math.round(Number(n) || 0));
  return `R$ ${v.toLocaleString('pt-BR')}`;
}

function installmentAmount(total: number, installments: number, indexZeroBased: number) {
  const count = Math.max(1, Math.floor(installments || 1));
  const totalInt = Math.max(0, Math.round(total || 0));
  const idx = Math.min(count - 1, Math.max(0, Math.floor(indexZeroBased || 0)));
  const base = Math.floor(totalInt / count);
  const remainder = totalInt % count;
  return base + (idx < remainder ? 1 : 0);
}


function playBeep(kind: 'notif' | 'warn' = 'notif') {
  // Som simples sem assets (beep)
  try {
    const Ctx: any = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.value = kind === 'warn' ? 440 : 880;
    g.gain.value = 0.05;
    o.connect(g);
    g.connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.06);
  } catch {}
}

function makeCode(payload: QrPayload) {
  return `BI|${btoa(unescape(encodeURIComponent(JSON.stringify(payload))))}`;
}
function parseCode(text: string): QrPayload | null {
  if (!text?.startsWith('BI|')) return null;
  try {
    const json = decodeURIComponent(escape(atob(text.slice(3))));
    const obj = JSON.parse(json);
    if (obj?.v !== 1) return null;
    return obj as QrPayload;
  } catch {
    return null;
  }
}
async function makeQrDataUrl(text: string) {
  try {
    // @ts-ignore
    return await QRCode.toDataURL(text, { margin: 4, width: 720, errorCorrectionLevel: 'M' });
  } catch {
    // fallback: tenta uma configuração mais simples
    // @ts-ignore
    return await QRCode.toDataURL(text, { margin: 4, width: 640, errorCorrectionLevel: 'M' });
  }
}

function normalizeArray<T>(val: any): T[] {
  if (!val) return [];
  if (Array.isArray(val)) return val.filter(Boolean);
  if (typeof val === 'object') return Object.values(val).filter(Boolean) as T[];
  return [];
}

/* ================= MODAL ================= */

function Modal({
  open,
  title,
  children,
  onClose,
  variant = 'scroll',
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
  variant?: 'scroll' | 'fit';
}) {
  if (!open) return null;
  if (typeof document === 'undefined') return null;

  const node = (
    <div className="mOverlay" role="dialog" aria-modal="true" onMouseDown={onClose}>
      <div className={`mCard ${variant === 'fit' ? 'mFit' : ''}`} onMouseDown={(e) => e.stopPropagation()}>
        <div className="mHead">
  {title ? <div className="mTitle">{title}</div> : <div />}
  <button className="mX" onClick={onClose} aria-label="Fechar">
    ✕
  </button>
</div>

        <div className="mBody">{children}</div>
      </div>

      <style jsx global>{`
        .mOverlay {
          position: fixed;
          inset: 0;
          z-index: 99999;
          background: rgba(0, 0, 0, 0.45);
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 18px;
        }
.mCard{
  width: min(620px, 100%);
  background: rgba(255,255,255,.96);
  backdrop-filter: blur(14px);
  border-radius: 22px;
  padding: 12px;
  box-shadow: 0 24px 70px rgba(0,0,0,.35);
  display: grid;
  grid-template-rows: auto 1fr;
  gap: 10px;
  max-height: calc(100vh - 36px);
  overflow: hidden;
}

.mBody{
  display: grid;
  gap: 10px;
  overflow: auto; /* modo normal pode rolar */
  -webkit-overflow-scrolling: touch;
}

/* ===== MODO “SEM ROLAGEM” ===== */
.mCard.mFit{
  max-height: min(640px, calc(100vh - 36px));
}

.mCard.mFit .mBody{
  overflow: hidden;          /* <- tira rolagem */
  align-content: start;
}

        .mHead {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          position: sticky;
          top: 0;
          background: rgba(255,255,255,0.9);
          backdrop-filter: blur(10px);
          padding-bottom: 6px;
        }
        .mTitle {
          font-weight: 1000;
          color: #1f1f1f;
        }
        .mX {
  width: 38px;
  height: 38px;
  border-radius: 14px;
  border: 0;
  background: rgba(0, 0, 0, 0.08);
  cursor: pointer;
  font-size: 16px;
  color: #0b5d4a;
  font-weight: 1000;
}
.mX:hover{
  background: rgba(11, 93, 74, 0.14);
}
       `}</style>
    </div>
  );

  return createPortal(node, document.body);
}

/* ======= cores do tabuleiro ======= */
const COLOR_HEX: Record<string, string> = {
  laranja: '#f59e0b',
  rosa: '#ec4899',
  violeta: '#4f46e5',
  'verde água': '#14b8a6',
  'verde agua': '#14b8a6',
  verde: '#22c55e',
  vermelho: '#ef4444',
  amarelo: '#eab308',
  roxo: '#0b5d4a',
  'azul escuro': '#1e3a8a',
};

/* ======= TODAS as propriedades (1..28) ======= */
function allProperties(): PropertyItem[] {
  const P = (o: Omit<PropertyItem, 'ownerUid' | 'houses' | 'hasHotel' | 'mortgaged'>) => ({
    ...o,
    ownerUid: BANK_UID,
    houses: 0 as 0,
    hasHotel: false,
    mortgaged: false,
  });

  return [
    // LARANJA 1..3
    P({
      id: 'p1',
      name: 'PRAÇA DOS TRES PODERES',
      colorName: 'Laranja',
      colorHex: COLOR_HEX['laranja'],
      kind: 'NORMAL',
      price: 320000,
      baseRent: 26000,
      rentByHouses: { 1: 130000, 2: 390000, 3: 900000, 4: 1100000 },
      hotel: 1275000,
      houseCost: 200000,
      hotelCost: 200000,
      sellValue: 150000,
    }),
    P({
      id: 'p2',
      name: 'PRAÇA CASTRO ALVES',
      colorName: 'Laranja',
      colorHex: COLOR_HEX['laranja'],
      kind: 'NORMAL',
      price: 300000,
      baseRent: 26000,
      rentByHouses: { 1: 130000, 2: 390000, 3: 900000, 4: 1100000 },
      hotel: 1275000,
      houseCost: 200000,
      hotelCost: 200000,
      sellValue: 150000,
    }),
    P({
      id: 'p3',
      name: 'PRAÇA AV. DO CONTORNO',
      colorName: 'Laranja',
      colorHex: COLOR_HEX['laranja'],
      kind: 'NORMAL',
      price: 300000,
      baseRent: 26000,
      rentByHouses: { 1: 130000, 2: 390000, 3: 900000, 4: 1100000 },
      hotel: 1275000,
      houseCost: 200000,
      hotelCost: 200000,
      sellValue: 150000,
    }),

    // ROSA 4..5
    P({
      id: 'p4',
      name: 'JARDINS',
      colorName: 'Rosa',
      colorHex: COLOR_HEX['rosa'],
      kind: 'NORMAL',
      price: 350000,
      baseRent: 35000,
      rentByHouses: { 1: 175000, 2: 500000, 3: 1100000, 4: 1300000 },
      hotel: 1500000,
      houseCost: 200000,
      hotelCost: 200000,
      sellValue: 200000,
    }),
    P({
      id: 'p5',
      name: 'HIGIENÓPOLIS',
      colorName: 'Rosa',
      colorHex: COLOR_HEX['rosa'],
      kind: 'NORMAL',
      price: 400000,
      baseRent: 50000,
      rentByHouses: { 1: 200000, 2: 600000, 3: 1400000, 4: 1700000 },
      hotel: 2000000,
      houseCost: 200000,
      hotelCost: 200000,
      sellValue: 175000,
    }),

    // VIOLETA 6..8
    P({
      id: 'p6',
      name: 'VIADUTO DO CHÁ',
      colorName: 'Violeta',
      colorHex: COLOR_HEX['violeta'],
      kind: 'NORMAL',
      price: 180000,
      baseRent: 16000,
      rentByHouses: { 1: 80000, 2: 220000, 3: 600000, 4: 800000 },
      hotel: 1000000,
      houseCost: 100000,
      hotelCost: 100000,
      sellValue: 100000,
    }),
    P({
      id: 'p7',
      name: 'RUA DA CONSOLAÇÃO',
      colorName: 'Violeta',
      colorHex: COLOR_HEX['violeta'],
      kind: 'NORMAL',
      price: 180000,
      baseRent: 14000,
      rentByHouses: { 1: 70000, 2: 200000, 3: 550000, 4: 750000 },
      hotel: 950000,
      houseCost: 100000,
      hotelCost: 100000,
      sellValue: 100000,
    }),
    P({
      id: 'p8',
      name: 'PRAÇA DA SÉ',
      colorName: 'Violeta',
      colorHex: COLOR_HEX['violeta'],
      kind: 'NORMAL',
      price: 200000,
      baseRent: 14000,
      rentByHouses: { 1: 70000, 2: 200000, 3: 550000, 4: 750000 },
      hotel: 950000,
      houseCost: 100000,
      hotelCost: 100000,
      sellValue: 100000,
    }),

    // VERDE ÁGUA 9..11
    P({
      id: 'p9',
      name: 'PONTE DO GUAÍBA',
      colorName: 'Verde água',
      colorHex: COLOR_HEX['verde água'],
      kind: 'NORMAL',
      price: 140000,
      baseRent: 10000,
      rentByHouses: { 1: 50000, 2: 150000, 3: 450000, 4: 625000 },
      hotel: 750000,
      houseCost: 100000,
      hotelCost: 100000,
      sellValue: 70000,
    }),
    P({
      id: 'p10',
      name: 'AV. RECIFE',
      colorName: 'Verde água',
      colorHex: COLOR_HEX['verde água'],
      kind: 'NORMAL',
      price: 140000,
      baseRent: 10000,
      rentByHouses: { 1: 50000, 2: 150000, 3: 450000, 4: 625000 },
      hotel: 750000,
      houseCost: 100000,
      hotelCost: 100000,
      sellValue: 70000,
    }),
    P({
      id: 'p11',
      name: 'AV. PAULISTA',
      colorName: 'Verde água',
      colorHex: COLOR_HEX['verde água'],
      kind: 'NORMAL',
      price: 140000,
      baseRent: 12000,
      rentByHouses: { 1: 60000, 2: 180000, 3: 500000, 4: 700000 },
      hotel: 900000,
      houseCost: 100000,
      hotelCost: 100000,
      sellValue: 80000,
    }),

    // VERDE 12..14
    P({
      id: 'p12',
      name: 'AV. BEIRA MAR',
      colorName: 'Verde',
      colorHex: COLOR_HEX['verde'],
      kind: 'NORMAL',
      price: 60000,
      baseRent: 6000,
      rentByHouses: { 1: 30000, 2: 90000, 3: 270000, 4: 400000 },
      hotel: 500000,
      houseCost: 50000,
      hotelCost: 50000,
      sellValue: 50000,
    }),
    P({
      id: 'p13',
      name: 'AV. NIEMEYER',
      colorName: 'Verde',
      colorHex: COLOR_HEX['verde'],
      kind: 'NORMAL',
      price: 75000,
      baseRent: 2000,
      rentByHouses: { 1: 10000, 2: 30000, 3: 90000, 4: 160000 },
      hotel: 250000,
      houseCost: 50000,
      hotelCost: 50000,
      sellValue: 50000,
    }),
    P({
      id: 'p14',
      name: 'JD. BOTÂNICO',
      colorName: 'Verde',
      colorHex: COLOR_HEX['verde'],
      kind: 'NORMAL',
      price: 100000,
      baseRent: 4000,
      rentByHouses: { 1: 20000, 2: 60000, 3: 180000, 4: 320000 },
      hotel: 450000,
      houseCost: 50000,
      hotelCost: 50000,
      sellValue: 50000,
    }),

    // VERMELHO 15..17
    P({
      id: 'p15',
      name: 'AV. IBIRAPUERA',
      colorName: 'Vermelho',
      colorHex: COLOR_HEX['vermelho'],
      kind: 'NORMAL',
      price: 220000,
      baseRent: 18000,
      rentByHouses: { 1: 90000, 2: 250000, 3: 700000, 4: 875000 },
      hotel: 1050000,
      houseCost: 150000,
      hotelCost: 150000,
      sellValue: 110000,
    }),
    P({
      id: 'p16',
      name: 'RUA OSCAR FREIRE',
      colorName: 'Vermelho',
      colorHex: COLOR_HEX['vermelho'],
      kind: 'NORMAL',
      price: 220000,
      baseRent: 20000,
      rentByHouses: { 1: 100000, 2: 300000, 3: 750000, 4: 925000 },
      hotel: 1100000,
      houseCost: 150000,
      hotelCost: 150000,
      sellValue: 120000,
    }),
    P({
      id: 'p17',
      name: 'AV. JUSCELINO KUBITSCHEK',
      colorName: 'Vermelho',
      colorHex: COLOR_HEX['vermelho'],
      kind: 'NORMAL',
      price: 240000,
      baseRent: 18000,
      rentByHouses: { 1: 90000, 2: 250000, 3: 700000, 4: 875000 },
      hotel: 1050000,
      houseCost: 150000,
      hotelCost: 150000,
      sellValue: 110000,
    }),

    // AMARELO 18..20
    P({
      id: 'p18',
      name: 'PONTE RIO-NITERÓI',
      colorName: 'Amarelo',
      colorHex: COLOR_HEX['amarelo'],
      kind: 'NORMAL',
      price: 280000,
      baseRent: 22000,
      rentByHouses: { 1: 110000, 2: 330000, 3: 800000, 4: 975000 },
      hotel: 1150000,
      houseCost: 150000,
      hotelCost: 150000,
      sellValue: 130000,
    }),
    P({
      id: 'p19',
      name: 'BARRA DA TIJUCA',
      colorName: 'Amarelo',
      colorHex: COLOR_HEX['amarelo'],
      kind: 'NORMAL',
      price: 260000,
      baseRent: 22000,
      rentByHouses: { 1: 110000, 2: 330000, 3: 800000, 4: 975000 },
      hotel: 1150000,
      houseCost: 150000,
      hotelCost: 150000,
      sellValue: 130000,
    }),
    P({
      id: 'p20',
      name: 'MARINA DA GLÓRIA',
      colorName: 'Amarelo',
      colorHex: COLOR_HEX['amarelo'],
      kind: 'NORMAL',
      price: 260000,
      baseRent: 26000,
      rentByHouses: { 1: 130000, 2: 360000, 3: 850000, 4: 1025000 },
      hotel: 1200000,
      houseCost: 150000,
      hotelCost: 150000,
      sellValue: 140000,
    }),

    // ROXO 21..22
    P({
      id: 'p21',
      name: 'AV. SÃO JOÃO',
      colorName: 'Roxo',
      colorHex: COLOR_HEX['roxo'],
      kind: 'NORMAL',
      price: 120000,
      baseRent: 8000,
      rentByHouses: { 1: 40000, 2: 100000, 3: 300000, 4: 450000 },
      hotel: 600000,
      houseCost: 50000,
      hotelCost: 50000,
      sellValue: 60000,
    }),
    P({
      id: 'p22',
      name: 'AV. IPIRANGA',
      colorName: 'Roxo',
      colorHex: COLOR_HEX['roxo'],
      kind: 'NORMAL',
      price: 100000,
      baseRent: 6000,
      rentByHouses: { 1: 30000, 2: 90000, 3: 270000, 4: 400000 },
      hotel: 500000,
      houseCost: 50000,
      hotelCost: 50000,
      sellValue: 50000,
    }),

    // AZUL ESCURO especiais 23..28 (multiplicador)
    P({
      id: 'p23',
      name: 'COMPANHIA PETROLÍFERA',
      colorName: 'Azul escuro',
      colorHex: COLOR_HEX['azul escuro'],
      kind: 'MULTIPLIER',
      price: 200000,
      multiplierValue: 50000,
      sellValue: 100000,
    }),
    P({
      id: 'p24',
      name: 'COMPANHIA DE ÁGUA E SANEAMENTO',
      colorName: 'Azul escuro',
      colorHex: COLOR_HEX['azul escuro'],
      kind: 'MULTIPLIER',
      price: 200000,
      multiplierValue: 50000,
      sellValue: 100000,
    }),
    P({
      id: 'p25',
      name: 'PONTOCOM',
      colorName: 'Azul escuro',
      colorHex: COLOR_HEX['azul escuro'],
      kind: 'MULTIPLIER',
      price: 150000,
      multiplierValue: 40000,
      sellValue: 75000,
    }),
    P({
      id: 'p26',
      name: 'CRÉDITOS DE CARBONO',
      colorName: 'Azul escuro',
      colorHex: COLOR_HEX['azul escuro'],
      kind: 'MULTIPLIER',
      price: 150000,
      multiplierValue: 40000,
      sellValue: 75000,
    }),
    P({
      id: 'p27',
      name: 'CENTRAL DE FORÇA E LUZ',
      colorName: 'Azul escuro',
      colorHex: COLOR_HEX['azul escuro'],
      kind: 'MULTIPLIER',
      price: 200000,
      multiplierValue: 50000,
      sellValue: 100000,
    }),
    P({
      id: 'p28',
      name: 'COMPANHIA DE MINERAÇÃO',
      colorName: 'Azul escuro',
      colorHex: COLOR_HEX['azul escuro'],
      kind: 'MULTIPLIER',
      price: 200000,
      multiplierValue: 50000,
      sellValue: 100000,
    }),
  ];
}

/* ===== SVG simples ===== */
function IconPix() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 2l4 4-4 4-4-4 4-4Z" stroke="currentColor" strokeWidth="2" />
      <path d="M12 14l4 4-4 4-4-4 4-4Z" stroke="currentColor" strokeWidth="2" />
      <path d="M2 12l4-4 4 4-4 4-4-4Z" stroke="currentColor" strokeWidth="2" />
      <path d="M22 12l-4-4-4 4 4 4 4-4Z" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}
function IconPay() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 7h16v10H4z" stroke="currentColor" strokeWidth="2" />
      <path d="M7 10h6" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

function IconCopy() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M9 9h10v10H9V9Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path
        d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconReceive() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 3v12" stroke="currentColor" strokeWidth="2" />
      <path d="M7 10l5 5 5-5" stroke="currentColor" strokeWidth="2" />
      <path d="M4 21h16" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}
function IconProps() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M3 10l9-7 9 7v10H3V10Z" stroke="currentColor" strokeWidth="2" />
      <path d="M9 20v-6h6v6" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}
/* ================= QR CAM (BarcodeDetector) ================= */

function QrCam({
  onCode,
  onFallback,
  onError,
}: {
  onCode: (code: string) => void;
  onFallback: () => void;
  onError: (msg: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stopRef = useRef(false);
  const onCodeRef = useRef(onCode);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onCodeRef.current = onCode;
  }, [onCode]);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    stopRef.current = false;
    let controls: any = null;
    const reader = new BrowserMultiFormatReader();

    async function start() {
      try {
        if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
          onErrorRef.current('Seu navegador não suporta câmera. Use "Colar código".');
          return;
        }

        const v = videoRef.current;
        if (!v) return;

        // iOS Safari: precisa playsInline + user gesture (o modal já é gesto)
        v.setAttribute('playsinline', 'true');

        controls = await reader.decodeFromConstraints(
          { video: { facingMode: { ideal: 'environment' } }, audio: false } as any,
          v,
          (result, err) => {
            if (stopRef.current) return;

            if (result) {
              stopRef.current = true;
              try { controls?.stop?.(); } catch {}
              onCodeRef.current(String(result.getText()));
              return;
            }

            // NotFoundException é normal enquanto não achou QR
           if (err && String(err?.name || err) !== 'NotFoundException') { }
          }
        );
      } catch {
        onErrorRef.current('Permissão negada ou erro ao acessar câmera. Use "Colar código".');
      }
    }

    start();

    return () => {
      stopRef.current = true;
      try { controls?.stop?.(); } catch {}
      // try { reader?.reset?.(); } catch {}
    };
  }, []);

  return (
    <div className="camWrap">
      <div className="camFrame">
        <video ref={videoRef} className="camVideo" playsInline muted />
        <div className="camLine" />
      </div>

      <div className="rowBtn" style={{ marginTop: 10 }}>
        <button className="btn" onClick={onFallback}>Colar código</button>
      </div>

      <div className="mHint" style={{ marginTop: 10 }}>
        Aponte a câmera para o QR. A linha no meio indica leitura.
      </div>
    </div>
  );
}



/* ================= PAGE ================= */

export default function HomePage() {
  const router = useRouter();

  /* ================= USUÁRIO ================= */

  const [uid, setUid] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [role, setRole] = useState<Role>('jogador');

  /* ================= SALA ================= */

  const [room, setRoom] = useState<RoomState | null>(null);

  const roomRefBase = useMemo(() => {
    return roomCode ? `rooms/${roomCode}` : '';
  }, [roomCode]);

  /* ================= PROPRIEDADES (BASE) ================= */

  const properties = useMemo(() => {
    return normalizeArray<PropertyItem>((room as any)?.properties);
  }, [room]);

  const propsAll = useMemo(() => {
    return properties ?? [];
  }, [properties]);

  const propsForPlayer = useMemo(() => {
    return propsAll.filter((property) => property.ownerUid === BANK_UID);
  }, [propsAll]);

  // filtros / ordenação propriedades
const [propQuery, setPropQuery] = useState('');
const [propColor, setPropColor] = useState<'all' | string>('all');
const [propSort, setPropSort] = useState<
  'none' | 'rent_desc' | 'rent_asc' | 'mort_desc' | 'mort_asc'
>('none');
const [propView, setPropView] = useState<'sale' | 'mine'>('sale');



  /* ================= PROPRIEDADES FILTRADAS E ORDENADAS ================= */

  const propsFilteredSorted = useMemo(() => {
    // Bancário vê todas as propriedades.
    // Jogador usa duas abas dentro do mesmo módulo: as dele ou as disponíveis no Banco.
    const baseList =
      role === 'bancario'
        ? propsAll
        : propView === 'mine'
        ? propsAll.filter((property) => property.ownerUid === uid)
        : propsAll.filter((property) => property.ownerUid === BANK_UID);

    const searchText = propQuery.trim().toLowerCase();

    let filteredList = baseList.filter((property) => {
      const matchesSearch = matchesQuery(property, searchText);

      const matchesColor =
        propColor === 'all'
          ? true
          : (property.colorName || '')
              .toLowerCase()
              === String(propColor).toLowerCase();

      return matchesSearch && matchesColor;
    });

    if (propSort !== 'none') {
      filteredList = [...filteredList].sort((a, b) => {
  if (propSort === 'rent_desc') {
          return rentComparable(b) - rentComparable(a);
        }

        if (propSort === 'rent_asc') {
          return rentComparable(a) - rentComparable(b);
        }

        if (propSort === 'mort_desc') {
          return (b.price || 0) - (a.price || 0);
        }

        if (propSort === 'mort_asc') {
          return (a.price || 0) - (b.price || 0);
        }

        return 0;
      });
    }

  return filteredList;
}, [propsAll, role, uid, propView, propQuery, propColor, propSort]);

  /* ================= RESTANTE DO COMPONENTE CONTINUA ABAIXO ================= */


  // modais gerais
  const [payOpen, setPayOpen] = useState(false);
  // pagar: motivo (só bancário) + preferência por câmera
  const [payReason, setPayReason] = useState<string>('');
  const [bankPayMenuOpen, setBankPayMenuOpen] = useState(false);
  const [scanCamOpen, setScanCamOpen] = useState(false);
  const [camError, setCamError] = useState('');
// transação online (sem QR)
const [txOpen, setTxOpen] = useState(false);
const [txToUid, setTxToUid] = useState('');
const [txAmount, setTxAmount] = useState(0);
const [txAmountText, setTxAmountText] = useState(money(0));
const [txTitle, setTxTitle] = useState('Transação');
const [txErr, setTxErr] = useState('');

  const [receiveOpen, setReceiveOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // receber / gerar QR simples
  const [rcvTitle, setRcvTitle] = useState('Recebimento');
  const [rcvAmount, setRcvAmount] = useState(200000);
  const [rcvAmountText, setRcvAmountText] = useState(money(200000));
  const [generatedCode, setGeneratedCode] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState<string>('');

  // pagar / ler QR
  const [scanText, setScanText] = useState('');
  const [scanError, setScanError] = useState('');
  const [payloadToPay, setPayloadToPay] = useState<QrPayload | null>(null);

  // confirmar pagamento
  const [confirmError, setConfirmError] = useState('');
  const [busy, setBusy] = useState(false);
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [lastReceipt, setLastReceipt] = useState<{
    id: string;
    at: number;
    title: string;
    amount: number;
    fromName: string;
    toName: string;
  } | null>(null);

  // vender propriedade (bancário)
  const [sellOpen, setSellOpen] = useState(false);
  const [sellPropId, setSellPropId] = useState('');
  const [sellToUid, setSellToUid] = useState('');
  const [sellMode, setSellMode] = useState<'avista' | 'parcelado'>('avista');
  const [sellPaymentMethod, setSellPaymentMethod] = useState<'pix' | 'cash' | 'bank_transfer'>('pix');
  const [sellInstallments, setSellInstallments] = useState(2);
  const [sellQr, setSellQr] = useState<string>(''); // dataUrl
  const [sellCode, setSellCode] = useState<string>(''); // BI|...

  const [sellBusy, setSellBusy] = useState(false);
  const [sellErr, setSellErr] = useState('');
  const [sellCashMsg, setSellCashMsg] = useState('');
  
  
  // popup bancário: venda paga -> transferir?
  const [paidPopupOpen, setPaidPopupOpen] = useState(false);
  const [pendingTransferSale, setPendingTransferSale] = useState<SaleDoc | null>(null);

  // cadeia (bancário)
  const [jailFlowOpen, setJailFlowOpen] = useState(false);
  const [jailTargetUid, setJailTargetUid] = useState<string>('');

  const [bailQrOpen, setBailQrOpen] = useState(false);
  const [bailQrUrl, setBailQrUrl] = useState('');
  const [bailCode, setBailCode] = useState('');

  const [bailPaidPopupOpen, setBailPaidPopupOpen] = useState(false);
  const [bailPaidPrisonerUid, setBailPaidPrisonerUid] = useState('');

  // aluguel: modal de escolher valor e gerar QR
  const [rentOpen, setRentOpen] = useState(false);
  const [rentPropId, setRentPropId] = useState('');
  const [rentDiceSum, setRentDiceSum] = useState<number>(7);
  const [rentPaymentMethod, setRentPaymentMethod] = useState<'pix' | 'cash'>('pix');
  const [rentCashPayerUid, setRentCashPayerUid] = useState('');
  const [rentCashMsg, setRentCashMsg] = useState('');
  const [rentQrUrl, setRentQrUrl] = useState('');
  const [rentCode, setRentCode] = useState('');

  // venda/transferência entre jogadores (gera QR e bancário confirma transferência)
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferPropId, setTransferPropId] = useState('');
  const [transferToUid, setTransferToUid] = useState('');
  const [transferPaymentMethod, setTransferPaymentMethod] = useState<'pix' | 'cash' | 'bank_transfer'>('pix');
  const [transferCashMsg, setTransferCashMsg] = useState('');
  const [transferQrUrl, setTransferQrUrl] = useState('');
  const [transferCode, setTransferCode] = useState('');

  const [transferPaidPopupOpen, setTransferPaidPopupOpen] = useState(false);
  const [pendingTransfer, setPendingTransfer] = useState<TransferDoc | null>(null);

  // dashboard: mostrar só 3
  const [showAllProps, setShowAllProps] = useState(false);
  const [viewPropOpen, setViewPropOpen] = useState(false);
  const [viewProp, setViewProp] = useState<any>(null);

  // UI: esconder saldo (olhinho)
  const [hideBalance, setHideBalance] = useState(false);

  // UI: notificações (sininho)
  type NotifItem = { id: string; at: number; title: string; detail?: string; kind: 'info' | 'success' | 'warning' };
  const [notifOpen, setNotifOpen] = useState(false);
  const [notifs, setNotifs] = useState<NotifItem[]>([]);
  const [notifUnread, setNotifUnread] = useState(0);
  const [focus, setFocus] = useState<'home' | 'props' | 'ledger' | 'pend'>('home');
  const lastNotifAtRef = useRef<number>(Date.now());
// finalizar partida (só bancário)
const [endGameOpen, setEndGameOpen] = useState(false);
const [endWinnerUid, setEndWinnerUid] = useState('');
const [endConfirmStep, setEndConfirmStep] = useState(false);
const [endCountdown, setEndCountdown] = useState(9);
const [endErr, setEndErr] = useState('');

const [gameEndedOpen, setGameEndedOpen] = useState(false);
const [gameEndedData, setGameEndedData] = useState<any>(null);

  /* ============ bootstrap ============ */
useEffect(() => {
  if (!roomCode) return;

  const gRef = ref(db, `${roomRefBase}/gameEnded`);
  const unsub = onValue(gRef, (snap) => {
    const v = snap.val();
    if (v && v.winnerUid) {
      setGameEndedData(v);
      setGameEndedOpen(true);
    }
  });

  return () => unsub();
}, [roomCode, roomRefBase]);


useEffect(() => {
  if (!endConfirmStep) return;

  setEndCountdown(9);
  const t = setInterval(() => {
    setEndCountdown((s) => s - 1);
  }, 1000);

  return () => clearInterval(t);
}, [endConfirmStep]);

useEffect(() => {
  if (!endConfirmStep) return;
  if (endCountdown > 0) return;

  // acabou o tempo: cancela
  setEndConfirmStep(false);
  setEndWinnerUid('');
  setEndGameOpen(false);
  setEndErr('');
}, [endCountdown, endConfirmStep]);

  useEffect(() => {
    const _uid = localStorage.getItem('uid') || '';
    const _name = localStorage.getItem('name') || '';
    const _email = localStorage.getItem('email') || '';
    const _room = localStorage.getItem('roomCode') || '';
    const _role = (localStorage.getItem('role') as Role) || 'jogador';

    if (!_uid || !_email || !_room) {
      router.push('/');
      return;
    }

    setUid(_uid);
    setName(_name);
    setEmail(_email);
    setRoomCode(_room);
    setRole(_role);
  }, [router]);

  /* ============ realtime room ============ */

  useEffect(() => {
    if (!roomCode || !uid) return;

    const pRef = ref(db, `${roomRefBase}/players/${uid}`);
    const heartbeat = setInterval(() => {
      update(pRef, { online: true, lastSeen: Date.now() }).catch(() => {});
    }, 4000);

    return () => clearInterval(heartbeat);
  }, [roomRefBase, roomCode, uid]);

  useEffect(() => {
    if (!roomCode) return;

    const roomRef = ref(db, `${roomRefBase}`);
    const unsub = onValue(roomRef, async (snap) => {
      const data = snap.val() || null;

      if (!data) {
        const base: RoomState = {
          roomCode,
          bankerUid: role === 'bancario' ? uid : '',
          settings: { startBonus: START_BALANCE, bail: BAIL_AMOUNT },
          players: {
            [BANK_UID]: {
              uid: BANK_UID,
              name: BANK_NAME,
              role: 'bancario',
              status: 'ativo',
              balance: BANK_BALANCE,
              debtToBank: 0,
              online: true,
              lastSeen: Date.now(),
            },
          },
          properties: [],
        };
        await set(ref(db, `${roomRefBase}`), base);
        return;
      }

      // garante bankerUid se bancário entrou e faltava
      if (role === 'bancario' && uid && !data.bankerUid) {
        await update(ref(db, `${roomRefBase}`), { bankerUid: uid });
      }

      // garante BANK pseudo-player
      if (!data.players) data.players = {};
      if (!data.players[BANK_UID]) {
        data.players[BANK_UID] = {
          uid: BANK_UID,
          name: BANK_NAME,
          role: 'bancario',
          status: 'ativo',
          balance: BANK_BALANCE,
          debtToBank: 0,
          online: true,
          lastSeen: Date.now(),
        };
        await update(ref(db, `${roomRefBase}/players/${BANK_UID}`), data.players[BANK_UID]);
      } else if ((data.players[BANK_UID]?.balance || 0) < BANK_BALANCE / 2) {
        await update(ref(db, `${roomRefBase}/players/${BANK_UID}`), { balance: BANK_BALANCE, name: BANK_NAME, role: 'bancario', status: 'ativo' });
      }

      setRoom(data as RoomState);
    });

    return () => unsub();
  }, [roomCode, roomRefBase, role, uid]);

  // garantir meu player doc + saldo inicial
  useEffect(() => {
    if (!roomCode || !uid || !name) return;

    const playerRef = ref(db, `${roomRefBase}/players/${uid}`);
    get(playerRef).then((snap) => {
      if (snap.exists()) {
        const v = snap.val() || {};
        const patch: any = { online: true, lastSeen: Date.now() };

        if (typeof v.balance !== 'number' || v.balance <= 0) {
          patch.balance = role === 'bancario' ? 0 : START_BALANCE;
        }
        if (!v.status) patch.status = 'ativo';
        if (!('debtToBank' in v)) patch.debtToBank = 0;

        update(playerRef, patch).catch(() => {});
        return;
      }

      set(playerRef, {
        uid,
        name,
        role,
        status: 'ativo',
        balance: role === 'bancario' ? 0 : START_BALANCE,
        debtToBank: 0,
        online: true,
        lastSeen: Date.now(),
      }).catch(() => {});
    });
  }, [roomRefBase, roomCode, uid, name, role]);

  // seed propriedades (só bancário e só se vazio)
  useEffect(() => {
  if (!room || role !== 'bancario') return;
  if (room.properties && room.properties.length > 0) return;

  const props = allProperties();
  update(ref(db, `${roomRefBase}`), { properties: props }).catch(() => {});
}, [room, role, roomRefBase]);


  /* ============ ledger realtime separado ============ */
  const [ledger, setLedger] = useState<LedgerItem[]>([]);
  useEffect(() => {
    if (!roomCode) return;
    const lRef = ref(db, `${roomRefBase}/ledger`);
    const unsub = onValue(lRef, (snap) => {
      const obj = snap.val() || {};
      const list: LedgerItem[] = Object.values(obj);
      list.sort((a: any, b: any) => (b.at || 0) - (a.at || 0));
      setLedger(list);
    });
    return () => unsub();
  }, [roomCode, roomRefBase]);

  /* ============ computed ============ */
  const me = useMemo(() => (room ? room.players?.[uid] : null), [room, uid]);
  const bankerUid = room?.bankerUid || '';
  const bankerName = room?.players?.[bankerUid]?.name || 'Bancário';

  const playersArr = useMemo(() => {
    if (!room?.players) return [];
    return Object.values(room.players)
      .filter((p) => p.uid !== BANK_UID)
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [room]);

  
  const filteredLedger = useMemo(() => {
    if (role === 'bancario') return ledger;
    return ledger.filter((l) => l.viewerUid === uid);
  }, [ledger, role, uid]);

  const visibleLedger = role === 'bancario' ? ledger : filteredLedger;

  // ============ VENDAS PARCELADAS (pendências) ============
  const salesArr = useMemo(() => {
    const raw: any = (room as any)?.sales;
    if (!raw) return [] as any[];
    const arr = Array.isArray(raw) ? raw : Object.values(raw);
    return (arr as any[]).filter(Boolean);
  }, [room]);

  const pendingSales = useMemo(() => {
    const list = salesArr.filter((s: any) => s?.status === 'pending_payment' || s?.status === 'paid_full');
    if (role === 'bancario') return list;
    return list.filter((s: any) => s?.buyerUid === uid);
  }, [salesArr, role, uid]);

  const transfersArr = useMemo(() => {
    const raw: any = (room as any)?.transfers;
    if (!raw) return [] as TransferDoc[];
    const arr = Array.isArray(raw) ? raw : Object.values(raw);
    return (arr as TransferDoc[]).filter(Boolean);
  }, [room]);

  const pendingBankPropertyTransfers = useMemo(() => {
    if (role !== 'jogador') return [] as TransferDoc[];
    return transfersArr.filter(
      (tr) => tr?.status === 'pending_payment' && tr?.paymentMethod === 'bank_transfer' && tr?.toUid === uid
    );
  }, [transfersArr, role, uid]);

  function saleInstallmentAmount(sale: any, indexZeroBased: number) {
    const inst = Math.max(1, Number(sale?.installments || 1));
    const total = Number(sale?.total || 0);
    return installmentAmount(total, inst, indexZeroBased);
  }

  async function paySaleByBankTransfer(saleLike: SaleDoc) {
    if (!room || !me || role !== 'jogador') return;
    if (saleLike.buyerUid !== uid) return;

    const inst = Math.max(1, Number(saleLike.installments || 1));
    const paidArr: boolean[] = Array.isArray(saleLike.paidInstallments)
      ? saleLike.paidInstallments
      : Array(inst).fill(false);
    const nextIdx = paidArr.findIndex((v) => !v);
    if (nextIdx < 0) return;

    const amount = saleInstallmentAmount(saleLike, nextIdx);
    if ((me.balance || 0) < amount) {
      alert('Saldo insuficiente para concluir a transferência.');
      return;
    }

    const installment = nextIdx + 1;
    const ok = window.confirm(
      `Transferir ${money(amount)} da sua conta para o Banco?\n\n${saleLike.propName} • Parcela ${installment}/${inst}`
    );
    if (!ok) return;

    const result = await runTransaction(ref(db, `${roomRefBase}`), (state: any) => {
      if (!state) return;
      const sale = state.sales?.[saleLike.id];
      const buyer = state.players?.[uid];
      if (!sale || sale.status !== 'pending_payment' || sale.buyerUid !== uid || !buyer) return;
      if (buyer.status === 'falido' || buyer.status === 'desistente') return;

      sale.paidInstallments = Array.isArray(sale.paidInstallments)
        ? sale.paidInstallments
        : Array(sale.installments).fill(false);
      if (sale.paidInstallments[nextIdx]) return;
      if ((buyer.balance || 0) < amount) return;

      buyer.balance = (buyer.balance || 0) - amount;
      sale.paidInstallments[nextIdx] = true;
      sale.paidCount = sale.paidInstallments.filter(Boolean).length;
      if (sale.paidCount >= sale.installments) {
        sale.status = 'paid_full';
        state.notifications = state.notifications || {};
        state.notifications.banker = { type: 'SALE_PAID', saleId: sale.id, at: Date.now() };
      }

      state.players[uid] = buyer;
      state.players[BANK_UID] = state.players[BANK_UID] || {
        uid: BANK_UID,
        name: BANK_NAME,
        role: 'bancario',
        status: 'ativo',
        balance: BANK_BALANCE,
        debtToBank: 0,
      };
      state.players[BANK_UID].balance = BANK_BALANCE;
      state.sales[saleLike.id] = sale;
      return state;
    });

    if (!result.committed) {
      alert('Não foi possível concluir. A parcela pode já ter sido paga ou a venda foi encerrada.');
      return;
    }

    const title = `${inst === 1 ? 'Compra' : `Parcela ${installment}/${inst}`} • ${saleLike.propName} • Transferência bancária`;
    await pushLedgerPair({
      title,
      amount,
      fromUid: uid,
      fromName: me.name,
      toUid: BANK_UID,
      toName: BANK_NAME,
      kindPaid: 'compra',
      kindReceived: 'venda',
      meta: {
        type: 'PROPERTY_PURCHASE',
        paymentMethod: 'bank_transfer',
        saleId: saleLike.id,
        installment,
        totalInstallments: inst,
        propId: saleLike.propId,
      },
    });

    setLastReceipt({
      id: `transfer-${saleLike.id}-${installment}-${Date.now()}`,
      at: Date.now(),
      title,
      amount,
      fromName: me.name,
      toName: BANK_NAME,
    });
    setReceiptOpen(true);
    playBeep('notif');
  }

  async function payPropertyByBankTransfer(trLike: TransferDoc) {
    if (!room || !me || role !== 'jogador') return;
    if (trLike.toUid !== uid || trLike.status !== 'pending_payment') return;
    const amount = Math.max(0, Number(trLike.amount || 0));
    if ((me.balance || 0) < amount) {
      alert('Saldo insuficiente para concluir a transferência.');
      return;
    }

    const ok = window.confirm(
      `Transferir ${money(amount)} para ${trLike.fromName}?\n\nCompra de ${trLike.propName}`
    );
    if (!ok) return;

    const result = await runTransaction(ref(db, `${roomRefBase}`), (state: any) => {
      if (!state) return;
      const tr = state.transfers?.[trLike.id];
      const buyer = state.players?.[uid];
      const seller = state.players?.[trLike.fromUid];
      if (!tr || tr.status !== 'pending_payment' || tr.toUid !== uid || tr.paymentMethod !== 'bank_transfer') return;
      if (!buyer || !seller) return;
      if (buyer.status === 'falido' || buyer.status === 'desistente') return;
      if ((buyer.balance || 0) < amount) return;

      const props = Array.isArray(state.properties) ? state.properties : Object.values(state.properties || {});
      const prop = (props as any[]).find((item: any) => item?.id === tr.propId);
      if (!prop || prop.ownerUid !== tr.fromUid) return;

      buyer.balance = (buyer.balance || 0) - amount;
      seller.balance = (seller.balance || 0) + amount;
      tr.status = 'paid';
      state.players[uid] = buyer;
      state.players[tr.fromUid] = seller;
      state.transfers[trLike.id] = tr;
      state.notifications = state.notifications || {};
      state.notifications.banker = { type: 'TRANSFER_PAID', transferId: tr.id, at: Date.now() };
      return state;
    });

    if (!result.committed) {
      alert('Não foi possível concluir. A negociação pode ter mudado ou já ter sido paga.');
      return;
    }

    const title = `Compra • ${trLike.propName} • Transferência bancária`;
    await pushLedgerPair({
      title,
      amount,
      fromUid: uid,
      fromName: me.name,
      toUid: trLike.fromUid,
      toName: trLike.fromName,
      kindPaid: 'compra',
      kindReceived: 'venda',
      meta: { type: 'PROP_TRANSFER', transferId: trLike.id, propId: trLike.propId, paymentMethod: 'bank_transfer' },
    });

    setLastReceipt({
      id: `transfer-${trLike.id}-${Date.now()}`,
      at: Date.now(),
      title,
      amount,
      fromName: me.name,
      toName: trLike.fromName,
    });
    setReceiptOpen(true);
    playBeep('notif');
  }

  async function openNextInstallmentQr(sale: any) {
    if (!room) return;
    const inst = Math.max(1, Number(sale?.installments || 1));
    const paidArr: boolean[] = Array.isArray(sale?.paidInstallments) ? sale.paidInstallments : Array(inst).fill(false);
    const nextIdx = paidArr.findIndex((v) => !v);
    if (nextIdx < 0) return;

    const installment = nextIdx + 1;
    const per = saleInstallmentAmount(sale, nextIdx);

    const payload = generatePayload(
      BANK_UID,
      BANK_NAME,
      `Parcela ${installment}/${inst} • ${sale.propName || 'Propriedade'}`,
      per,
      'BUY_INSTALLMENT',
      { saleId: sale.id, installment, totalInstallments: inst, propId: sale.propId, buyerUid: sale.buyerUid }
    );
    const code = makeCode(payload);

    setRcvTitle(`Parcela ${installment}/${inst} • ${sale.propName || 'Propriedade'}`);
    setGeneratedCode(code);
    setQrDataUrl(await makeQrDataUrl(code));
    setReceiveOpen(true);
  }

  async function receiveNextInstallmentCash(sale: SaleDoc) {
    try {
      await registerCashSaleInstallment(sale);
      playBeep('notif');
    } catch (e: any) {
      window.alert(e?.message || 'Não foi possível registrar a parcela em dinheiro.');
    }
  }


  const isBlocked = me?.status === 'preso';
  const isClosed = me?.status === 'falido' || me?.status === 'desistente';
  const showReceive = role === 'bancario' ? true : !isBlocked && !isClosed;


  // ============ NOTIFICAÇÕES (sininho) ============
useEffect(() => {
  const list = visibleLedger || [];
  if (!list.length) return;

  const newestAt = Math.max(0, ...list.map((l: any) => (l?.at || 0)));
  const newOnes = list.filter((l: any) => (l?.at || 0) > lastNotifAtRef.current).slice(0, 5);

 if (newOnes.length) {
  setNotifs((prev) =>
    [
      ...newOnes.map((l: any): NotifItem => {
        const kind: NotifItem['kind'] =
          Number(l.amount ?? 0) >= 0 ? 'success' : 'warning'

        return {
          id: `ld-${l.id || Math.random().toString(36).slice(2)}`,
          at: Number(l.at ?? Date.now()),
          title: String(l.title ?? 'Movimentação'),
          detail: l.detail ? String(l.detail) : undefined,
          kind,
        }
      }),
      ...prev,
    ].slice(0, 40)
  )
}

  // jogador: quando ficar preso, avisa uma vez
  if (role === 'jogador' && me?.status === 'preso') {
    setNotifs((prev) => {
      if (prev.some((n) => n.id === 'status-preso')) return prev;

      return [
        {
          id: 'status-preso',
          at: Date.now(),
          title: 'Você foi preso',
          detail: 'Contas bloqueadas até o bancário liberar.',
          kind: 'warning' as const,
        },
        ...prev,
      ].slice(0, 40);
    });

    setNotifUnread((u) => u + 1);
    playBeep('warn');
  }

  if (newestAt) lastNotifAtRef.current = Math.max(lastNotifAtRef.current, newestAt);
}, [visibleLedger, role, me?.status]);

// jogador não vê “vendidas”
  const availableProps = role === 'bancario' ? propsAll.filter((p) => p.ownerUid === BANK_UID) : propsForPlayer;
const myProps = useMemo(() => {
  if (!uid) return [];
  return propsAll.filter((p) => p.ownerUid === uid);
}, [propsAll, uid]);

  /* ============ helpers RTDB ============ */
  function stripUndefinedDeep(value: any): any {
  if (value === undefined) return undefined;
  if (value === null) return null;

  if (Array.isArray(value)) {
    const arr = value
      .map(stripUndefinedDeep)
      .filter((v) => v !== undefined);
    return arr;
  }

  if (typeof value === "object") {
    const out: any = {};
    for (const [k, v] of Object.entries(value)) {
      const cleaned = stripUndefinedDeep(v);
      if (cleaned !== undefined) out[k] = cleaned;
    }
    return out;
  }

  return value;
}
 
  async function pushLedgerPair(args: {
    title: string;
    amount: number;
    fromUid: string;
    fromName: string;
    toUid: string;
    toName: string;
    kindPaid: LedgerItem['kind'];
    kindReceived: LedgerItem['kind'];
    meta?: any;
  }) {
    const lRef = ref(db, `${roomRefBase}/ledger`);
    const safeMeta = stripUndefinedDeep(args.meta);
    const paid: LedgerItem = {
      id: idNow(),
      at: Date.now(),
      title: args.title,
      amount: -Math.abs(args.amount),
      kind: args.kindPaid,
      from: args.fromName,
      to: args.toName,
      meta: (safeMeta !== undefined ? { meta: safeMeta } : {}),
      viewerUid: args.fromUid,
    };
    const rec: LedgerItem = {
      id: idNow(),
      at: Date.now(),
      title: args.title,
      amount: Math.abs(args.amount),
      kind: args.kindReceived,
      from: args.fromName,
      to: args.toName,
      meta: (safeMeta !== undefined ? { meta: safeMeta } : {}),
      viewerUid: args.toUid,
    };

    const p1 = push(lRef);
    const p2 = push(lRef);
    await set(p1, paid);
    await set(p2, rec);
  }

  /* ============ QR ============ */
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {}
  }

  function generatePayload(
    toUid: string,
    toName: string,
    title: string,
    amount: number,
    kind: QrPayload['kind'],
    meta?: any
  ) {
    const payload: QrPayload = {
      v: 1,
      room: roomCode,
      paymentId: `pay-${idNow()}`,
      kind,
      toUid,
      toName,
      amount,
      title: title.slice(0, 80),
      createdAt: Date.now(),
      meta,
    };
    return payload;
  }

  async function clickGenerateReceive() {
    if (!uid || !me) return;
    setRcvAmountText(money(Math.max(0, Number(rcvAmount || 0))));

    const amount = Math.max(0, Number(rcvAmount || 0));
    const receiverUid = role === 'bancario' ? BANK_UID : uid;
    const receiverName = role === 'bancario' ? BANK_NAME : me.name;
    const payload = generatePayload(receiverUid, receiverName, rcvTitle || 'Recebimento', amount, 'TRANSFER');
    const code = makeCode(payload);

    setGeneratedCode(code);
    setQrDataUrl(await makeQrDataUrl(code));
  }

  /* ============ PAGAR (colar QR) ============ */
  function openPay(reason?: string) {
    setPayReason(reason || '');
    setScanText('');
    setScanError('');
    setPayloadToPay(null);
    setConfirmError('');
    // preferir câmera; se não der, o usuário pode colar o código
    setCamError('');
    setScanCamOpen(true);
  }

function openOnlineTransfer() {
  setTxErr('');
  if (!room || !me) return;
  if (!txToUid) return setTxErr('Selecione um jogador.');
  const amount = Math.max(0, Number(txAmount || 0));
  if (amount <= 0) return setTxErr('Valor inválido.');

  const to = room.players?.[txToUid];
  if (!to) return setTxErr('Jogador não encontrado.');

  const payload = generatePayload(txToUid, to.name, txTitle || 'Transação', amount, 'TRANSFER');
  setPayloadToPay(payload);
  setConfirmError('');
  setConfirmOpen(true);
  setTxOpen(false);
}


  function previewPaymentCode(rawCode: string) {
    setScanError('');
    const payload = parseCode(rawCode.trim());
    if (!payload) return setScanError('QR inválido.');
    if (payload.room !== roomCode) return setScanError('QR de outra sala.');
    if (payload.amount <= 0) return setScanError('Valor inválido.');
    setPayloadToPay(payload);
    setConfirmOpen(true);
  }

  function parseAndPreview() {
    previewPaymentCode(scanText);
  }
    
    async function confirmPay() {
    setConfirmError('');
    if (!room || !me || !payloadToPay) return;

    const payerUid = role === 'bancario' ? BANK_UID : uid;
    const payerName = role === 'bancario' ? BANK_NAME : me.name;
    const amount = Math.abs(payloadToPay.amount);
    const paymentId = payloadToPay.paymentId || `legacy-${payloadToPay.createdAt}-${payloadToPay.toUid}-${amount}`;

    if (payerUid !== BANK_UID && me.balance < amount) {
      return setConfirmError('Saldo insuficiente.');
    }
    if (payerUid === payloadToPay.toUid) {
      return setConfirmError('Origem e destino não podem ser a mesma conta.');
    }

    setBusy(true);
    try {
      const result = await runTransaction(ref(db, `${roomRefBase}`), (state: any) => {
        if (!state) return;

        state.players = state.players || {};
        state.processedPayments = state.processedPayments || {};
        const players = state.players;
        const toUid = payloadToPay.toUid;

        // Um QR/Pix só pode ser liquidado uma vez.
        if (state.processedPayments[paymentId]) return;

        if (!players[BANK_UID]) {
          players[BANK_UID] = {
            uid: BANK_UID,
            name: BANK_NAME,
            role: 'bancario',
            status: 'ativo',
            balance: BANK_BALANCE,
            debtToBank: 0,
          };
        }
        players[BANK_UID].balance = BANK_BALANCE;

        if (payerUid !== BANK_UID) {
          const payer = players[payerUid];
          if (!payer) return;
          if (payer.status === 'falido' || payer.status === 'desistente') return;
          if ((payer.balance || 0) < amount) return;
        }

        if (toUid !== BANK_UID) {
          const receiver = players[toUid];
          if (!receiver) return;
          if (receiver.status === 'falido' || receiver.status === 'desistente') return;
        }

        // Valida a parcela ANTES de movimentar o dinheiro.
        if (payloadToPay.kind === 'BUY_INSTALLMENT') {
          const saleId = payloadToPay.meta?.saleId as string | undefined;
          const inst = Number(payloadToPay.meta?.installment || 0);
          if (!saleId || !Number.isFinite(inst)) return;

          state.sales = state.sales || {};
          const sale = state.sales[saleId];
          if (!sale || sale.status !== 'pending_payment' || sale.buyerUid !== payerUid) return;

          const idx = inst - 1;
          if (idx < 0 || idx >= sale.installments) return;
          sale.paidInstallments = sale.paidInstallments || Array(sale.installments).fill(false);
          if (sale.paidInstallments[idx]) return;

          const expected = installmentAmount(Number(sale.total || 0), Number(sale.installments || 1), idx);
          if (amount !== expected) return;
        }

        // Valida compra entre jogadores antes de movimentar.
        if (payloadToPay.kind === 'TRANSFER' && payloadToPay.meta?.type === 'PROP_TRANSFER') {
          const transferId = payloadToPay.meta?.transferId as string | undefined;
          const tr = transferId ? state.transfers?.[transferId] : null;
          if (!tr || tr.status !== 'pending_payment' || tr.toUid !== payerUid) return;
          if (Number(tr.amount || 0) !== amount || tr.fromUid !== toUid) return;
        }

        if (payerUid !== BANK_UID) {
          players[payerUid].balance = (players[payerUid].balance || 0) - amount;
        }
        if (toUid !== BANK_UID) {
          players[toUid].balance = (players[toUid].balance || 0) + amount;
        }
        players[BANK_UID].balance = BANK_BALANCE;

        if (payloadToPay.kind === 'BUY_INSTALLMENT') {
          const saleId = payloadToPay.meta?.saleId as string;
          const inst = Number(payloadToPay.meta?.installment || 0);
          const sale = state.sales[saleId];
          const idx = inst - 1;

          sale.paidInstallments[idx] = true;
          sale.paidCount = sale.paidInstallments.filter(Boolean).length;

          if (sale.paidCount >= sale.installments) {
            sale.status = 'paid_full';
            state.notifications = state.notifications || {};
            state.notifications.banker = { type: 'SALE_PAID', saleId: sale.id, at: Date.now() };
          }
          state.sales[saleId] = sale;
        }

        if (payloadToPay.kind === 'TRANSFER' && payloadToPay.meta?.type === 'BAIL') {
          const prisonerUid = payloadToPay.meta?.prisonerUid as string | undefined;
          if (prisonerUid) {
            state.notifications = state.notifications || {};
            state.notifications.banker = { type: 'BAIL_PAID', prisonerUid, at: Date.now() };
          }
        }

        if (payloadToPay.kind === 'TRANSFER' && payloadToPay.meta?.type === 'PROP_TRANSFER') {
          const transferId = payloadToPay.meta?.transferId as string;
          const tr = state.transfers[transferId];
          tr.status = 'paid';
          state.transfers[transferId] = tr;
          state.notifications = state.notifications || {};
          state.notifications.banker = { type: 'TRANSFER_PAID', transferId, at: Date.now() };
        }

        state.processedPayments[paymentId] = {
          id: paymentId,
          at: Date.now(),
          fromUid: payerUid,
          toUid,
          amount,
          title: payloadToPay.title,
        };

        state.players = players;
        return state;
      });

      if (!result.committed) {
        setConfirmError('Este Pix já foi pago, expirou ou não é mais válido.');
        return;
      }

      const meta = payloadToPay.meta;
      const kindPaid: LedgerItem['kind'] =
        payloadToPay.kind === 'BUY_INSTALLMENT'
          ? 'compra'
          : meta?.type === 'BAIL'
          ? 'fiança'
          : meta?.type === 'RENT'
          ? 'aluguel'
          : 'pago';

      const kindReceived: LedgerItem['kind'] =
        payloadToPay.kind === 'BUY_INSTALLMENT'
          ? 'venda'
          : meta?.type === 'RENT'
          ? 'aluguel'
          : 'recebido';

      const finalTitle = role === 'bancario' && payReason ? `${payReason} • ${payloadToPay.title}` : payloadToPay.title;
      const receiverName =
        payloadToPay.toUid === BANK_UID
          ? BANK_NAME
          : room.players[payloadToPay.toUid]?.name || payloadToPay.toName || 'Recebedor';

      await pushLedgerPair({
        title: finalTitle,
        amount,
        fromUid: payerUid,
        fromName: payerName,
        toUid: payloadToPay.toUid,
        toName: receiverName,
        kindPaid,
        kindReceived,
        meta: { ...(payloadToPay.meta || {}), paymentId, paymentMethod: 'pix' },
      });

      setLastReceipt({
        id: paymentId,
        at: Date.now(),
        title: finalTitle,
        amount,
        fromName: payerName,
        toName: receiverName,
      });
      setReceiptOpen(true);
      setPayloadToPay(null);
      setConfirmOpen(false);
      setPayOpen(false);
      setPayReason('');
    } catch (e: any) {
      console.error('PAYMENT ERROR:', e?.code, e?.message);
      setConfirmError('Não foi possível concluir o pagamento.');
    } finally {
      setBusy(false);
    }
  }

/* ============ VENDA DE PROPRIEDADE (bancário) ============ */

  function openSell(propId: string) {
  const prop = properties.find((p) => p.id === propId);
  if (!prop) return;
  if (prop.ownerUid !== BANK_UID) return; // não vende se já foi vendida

  setSellPropId(propId);
  setSellToUid('');
  setSellMode('avista');
  setSellPaymentMethod('pix');
  setSellInstallments(2);
  setSellQr('');
  setSellCode('');
  setSellCashMsg('');
  setSellOpen(true);
}

  async function generateSellQr() {
    if (!room) return;
    // este fluxo é só do bancário
    if (role !== 'bancario') return;

    setSellErr('');
    setSellBusy(true);

    try {
      const prop = properties.find((p) => p.id === sellPropId);
      const buyer = room.players?.[sellToUid];

      if (!prop) throw new Error('Propriedade não encontrada.');
      if (!buyer) throw new Error('Selecione um jogador.');

      const installments = sellMode === 'avista' ? 1 : Math.min(6, Math.max(2, sellInstallments));
      const perInstallment = installmentAmount(prop.price, installments, 0);

      const saleId = `sale-${idNow()}`;

      const sale: SaleDoc = {
        id: saleId,
        at: Date.now(),
        roomCode,
        propId: prop.id,
        propName: prop.name,
        buyerUid: buyer.uid,
        buyerName: buyer.name,
        total: prop.price,
        mode: sellMode,
        installments,
        paidInstallments: Array(installments).fill(false),
        paidCount: 0,
        status: 'pending_payment',
        paymentMethod: sellPaymentMethod,
      };

      await set(ref(db, `${roomRefBase}/sales/${saleId}`), sale);

      if (sellPaymentMethod === 'cash') {
        await registerCashSaleInstallment(sale);
        setSellQr('');
        setSellCode('');
        setSellCashMsg(
          installments === 1
            ? 'Pagamento em dinheiro registrado. Confirme a transferência da propriedade.'
            : `1ª parcela em dinheiro registrada. Restam ${installments - 1} parcela(s).`
        );
        playBeep('notif');
        return;
      }

      if (sellPaymentMethod === 'bank_transfer') {
        setSellQr('');
        setSellCode('');
        setSellCashMsg(
          installments === 1
            ? `Transferência criada para ${buyer.name}. O comprador paga pela área Pendências da própria conta.`
            : `Compra parcelada criada para ${buyer.name}. As parcelas podem ser pagas por Transferência na área Pendências.`
        );
        playBeep('notif');
        return;
      }

      const payload = generatePayload(
        BANK_UID,
        BANK_NAME,
        installments === 1 ? `À vista • ${prop.name}` : `Parcela 1/${installments} • ${prop.name}`,
        perInstallment,
        'BUY_INSTALLMENT',
        { saleId, installment: 1, totalInstallments: installments, propId: prop.id, buyerUid: buyer.uid }
      );
      const code = makeCode(payload);

      setSellCode(code);

      // gera a imagem do QR (mostra no modal)
      const url = await makeQrDataUrl(code);
      setSellQr(url);
      
      playBeep('notif');
    } catch (e: any) {
      setSellQr('');
      setSellCode('');
      setSellErr(e?.message || 'Erro ao gerar QR.');
      
    } finally {
      setSellBusy(false);
    }
  }
  


  async function registerCashSaleInstallment(saleLike: SaleDoc) {
    if (!room || role !== 'bancario') return;

    const inst = Math.max(1, Number(saleLike.installments || 1));
    const paidArr: boolean[] = Array.isArray(saleLike.paidInstallments)
      ? saleLike.paidInstallments
      : Array(inst).fill(false);
    const nextIdx = paidArr.findIndex((v) => !v);
    if (nextIdx < 0) return;

    const amount = installmentAmount(Number(saleLike.total || 0), inst, nextIdx);
    const installment = nextIdx + 1;
    const buyer = room.players?.[saleLike.buyerUid];
    if (!buyer) throw new Error('Comprador não encontrado.');

    const result = await runTransaction(ref(db, `${roomRefBase}`), (state: any) => {
      if (!state) return;
      const sale = state.sales?.[saleLike.id];
      if (!sale || sale.status !== 'pending_payment') return;
      if (sale.buyerUid !== saleLike.buyerUid) return;

      const buyerState = state.players?.[sale.buyerUid];
      if (!buyerState || buyerState.status === 'falido' || buyerState.status === 'desistente') return;

      sale.paidInstallments = Array.isArray(sale.paidInstallments)
        ? sale.paidInstallments
        : Array(sale.installments).fill(false);
      if (sale.paidInstallments[nextIdx]) return;

      sale.paidInstallments[nextIdx] = true;
      sale.paidCount = sale.paidInstallments.filter(Boolean).length;

      if (sale.paidCount >= sale.installments) {
        sale.status = 'paid_full';
        state.notifications = state.notifications || {};
        state.notifications.banker = { type: 'SALE_PAID', saleId: sale.id, at: Date.now() };
      }

      state.sales[sale.id] = sale;
      return state;
    });

    if (!result.committed) throw new Error('Essa parcela já foi registrada ou a venda não está mais disponível.');

    await pushLedgerPair({
      title: `${installment === inst && inst === 1 ? 'Compra' : `Parcela ${installment}/${inst}`} • ${saleLike.propName} • Dinheiro`,
      amount,
      fromUid: saleLike.buyerUid,
      fromName: saleLike.buyerName,
      toUid: BANK_UID,
      toName: BANK_NAME,
      kindPaid: 'compra',
      kindReceived: 'venda',
      meta: {
        type: 'PROPERTY_PURCHASE',
        paymentMethod: 'cash',
        saleId: saleLike.id,
        installment,
        totalInstallments: inst,
        propId: saleLike.propId,
      },
    });
  }

  /* ============ NOTIFICAÇÕES DO BANCÁRIO ============ */
  useEffect(() => {
    if (!roomCode || role !== 'bancario' || !uid) return;

    const notifRef = ref(db, `${roomRefBase}/notifications/banker`);
    const unsub = onValue(notifRef, (snap) => {
      const n = snap.val() as BankerNotification | null;
      if (!n?.type) return;

      if (n.type === 'SALE_PAID' && n.saleId) {
        get(ref(db, `${roomRefBase}/sales/${n.saleId}`)).then((sSale) => {
          const sale = sSale.val() as SaleDoc | null;
          if (sale && sale.status === 'paid_full') {
            setPendingTransferSale(sale);
            setPaidPopupOpen(true);
          }
        });
      }

      if (n.type === 'BAIL_PAID' && n.prisonerUid) {
        setBailPaidPrisonerUid(n.prisonerUid);
        setBailPaidPopupOpen(true);
      }

      if (n.type === 'TRANSFER_PAID' && n.transferId) {
        get(ref(db, `${roomRefBase}/transfers/${n.transferId}`)).then((sTr) => {
          const tr = sTr.val() as TransferDoc | null;
          if (tr && tr.status === 'paid') {
            setPendingTransfer(tr);
            setTransferPaidPopupOpen(true);
          }
        });
      }

      // limpa notificação
      set(notifRef, null).catch(() => {});
    });

    return () => unsub();
  }, [roomCode, role, uid, roomRefBase]);

  /* ============ CONFIRMAR TRANSFERÊNCIA (banco -> jogador) ============ */
  async function confirmTransferNow() {
    if (!pendingTransferSale || !room) return;

    const saleId = pendingTransferSale.id;

    await runTransaction(ref(db, `${roomRefBase}`), (state: any) => {
      if (!state) return state;

      const sale = state.sales?.[saleId];
      if (!sale) return state;
      if (sale.status !== 'paid_full') return state;

      const props: PropertyItem[] = state.properties || [];
      const idx = props.findIndex((p) => p.id === sale.propId);
      if (idx >= 0) {
        props[idx].ownerUid = sale.buyerUid;
      }
      state.properties = props;

      sale.status = 'transferred';
      state.sales[saleId] = sale;

      return state;
    });

    setPaidPopupOpen(false);
    setPendingTransferSale(null);
  }

  /* ============ CADEIA (bancário) ============ */
  async function jailHabeas(prisonerUid: string) {
    await update(ref(db, `${roomRefBase}/players/${prisonerUid}`), { status: 'ativo' });
    setJailFlowOpen(false);
    setJailTargetUid('');
  }

  async function jailGenerateBailQr(prisonerUid: string) {
    const prisonerName = room?.players?.[prisonerUid]?.name || 'Jogador';

    // QR: jogador paga 50k para o BANCO, meta marca como fiança
    const payload = generatePayload(
      BANK_UID,
      BANK_NAME,
      `Fiança (Cadeia) • ${prisonerName}`,
      BAIL_AMOUNT,
      'TRANSFER',
      { type: 'BAIL', prisonerUid }
    );
    const code = makeCode(payload);
    setBailCode(code);
    setBailQrUrl(await makeQrDataUrl(code));
    setBailQrOpen(true);
  }

  async function bankerUnlockAfterBail(prisonerUid: string) {
    await update(ref(db, `${roomRefBase}/players/${prisonerUid}`), { status: 'ativo' });
    setBailPaidPopupOpen(false);
    setBailPaidPrisonerUid('');
  }

  /* ============ ALUGUEL (jogador) ============ */
  function openRent(propId: string) {
    setRentPropId(propId);
    setRentDiceSum(7);
    setRentPaymentMethod('pix');
    setRentCashPayerUid('');
    setRentCashMsg('');
    setRentQrUrl('');
    setRentCode('');
    setRentOpen(true);
  }

  async function generateRentQr(amount: number, title: string, meta: any) {
    if (!me) return;
    const payload = generatePayload(uid, me.name, title, amount, 'TRANSFER', meta);
    const code = makeCode(payload);
    setRentCode(code);
    setRentQrUrl(await makeQrDataUrl(code));
  }

  async function chargeRent(amount: number, title: string, meta: any) {
    setRentCashMsg('');
    setRentQrUrl('');
    setRentCode('');
    if (amount <= 0) return setRentCashMsg('Valor de aluguel inválido.');

    if (rentPaymentMethod === 'pix') {
      await generateRentQr(amount, title, meta);
      return;
    }

    if (!room || !me) return;
    const payer = room.players?.[rentCashPayerUid];
    if (!payer) return setRentCashMsg('Selecione quem pagou em dinheiro.');
    if (payer.uid === uid) return setRentCashMsg('O proprietário não pode pagar o próprio aluguel.');
    if (payer.status === 'falido' || payer.status === 'desistente') return setRentCashMsg('Essa conta está encerrada.');

    const ok = window.confirm(`Confirmar ${money(amount)} em dinheiro recebido de ${payer.name}?`);
    if (!ok) return;

    await pushLedgerPair({
      title: `${title} • Dinheiro`,
      amount,
      fromUid: payer.uid,
      fromName: payer.name,
      toUid: uid,
      toName: me.name,
      kindPaid: 'aluguel',
      kindReceived: 'aluguel',
      meta: { ...meta, paymentMethod: 'cash' },
    });

    setRentCashPayerUid('');
    setRentCashMsg(`Recebimento em dinheiro registrado: ${money(amount)}.`);
    playBeep('notif');
  }

  /* ============ TRANSFERIR/VENDER PROPRIEDADE (jogador) ============ */
  function openTransfer(propId: string) {
    setTransferPropId(propId);
    setTransferToUid('');
    setTransferPaymentMethod('pix');
    setTransferCashMsg('');
    setTransferQrUrl('');
    setTransferCode('');
    setTransferOpen(true);
  }

  async function generateTransferQr() {
    if (!room || !me) return;
    const prop = properties.find((p) => p.id === transferPropId);
    const buyer = room.players?.[transferToUid];
    if (!prop || !buyer) return;
    if (prop.ownerUid !== uid) return;

    const transferId = `tr-${idNow()}`;

    const doc: TransferDoc = {
      id: transferId,
      at: Date.now(),
      roomCode,
      propId: prop.id,
      propName: prop.name,
      fromUid: uid,
      fromName: me.name,
      toUid: buyer.uid,
      toName: buyer.name,
      amount: prop.sellValue,
      status: 'pending_payment',
      paymentMethod: 'pix',
    };

    await set(ref(db, `${roomRefBase}/transfers/${transferId}`), doc);

    // comprador paga o VENDEDOR (você)
    const payload = generatePayload(
      uid,
      me.name,
      `Compra • ${prop.name}`,
      prop.sellValue,
      'TRANSFER',
      { type: 'PROP_TRANSFER', transferId, propId: prop.id, fromUid: uid, toUid: buyer.uid }
    );
    const code = makeCode(payload);
    setTransferCode(code);
    setTransferQrUrl(await makeQrDataUrl(code));
  }


  async function createBankPropertyTransferRequest() {
    if (!room || !me) return;
    setTransferCashMsg('');
    const prop = properties.find((p) => p.id === transferPropId);
    const buyer = room.players?.[transferToUid];
    if (!prop || !buyer) return setTransferCashMsg('Selecione o comprador.');
    if (prop.ownerUid !== uid) return setTransferCashMsg('Você não é mais dono desta propriedade.');
    if (buyer.status === 'falido' || buyer.status === 'desistente') return setTransferCashMsg('A conta do comprador está encerrada.');

    const transferId = `tr-${idNow()}`;
    const doc: TransferDoc = {
      id: transferId,
      at: Date.now(),
      roomCode,
      propId: prop.id,
      propName: prop.name,
      fromUid: uid,
      fromName: me.name,
      toUid: buyer.uid,
      toName: buyer.name,
      amount: prop.sellValue,
      status: 'pending_payment',
      paymentMethod: 'bank_transfer',
    };

    await set(ref(db, `${roomRefBase}/transfers/${transferId}`), doc);
    setTransferQrUrl('');
    setTransferCode('');
    setTransferCashMsg(
      `Transferência criada para ${buyer.name}. Ele deve abrir Pendências e confirmar o pagamento de ${money(prop.sellValue)}.`
    );
    playBeep('notif');
  }

  async function registerCashPropertyTransfer() {
    if (!room || !me) return;
    setTransferCashMsg('');
    const prop = properties.find((p) => p.id === transferPropId);
    const buyer = room.players?.[transferToUid];
    if (!prop || !buyer) return setTransferCashMsg('Selecione o comprador.');
    if (prop.ownerUid !== uid) return setTransferCashMsg('Você não é mais dono desta propriedade.');
    if (buyer.status === 'falido' || buyer.status === 'desistente') return setTransferCashMsg('A conta do comprador está encerrada.');

    const ok = window.confirm(`Confirmar que ${buyer.name} pagou ${money(prop.sellValue)} em dinheiro por ${prop.name}?`);
    if (!ok) return;

    const transferId = `tr-${idNow()}`;
    const doc: TransferDoc = {
      id: transferId,
      at: Date.now(),
      roomCode,
      propId: prop.id,
      propName: prop.name,
      fromUid: uid,
      fromName: me.name,
      toUid: buyer.uid,
      toName: buyer.name,
      amount: prop.sellValue,
      status: 'paid',
      paymentMethod: 'cash',
    };

    await update(ref(db, `${roomRefBase}`), {
      [`transfers/${transferId}`]: doc,
      'notifications/banker': { type: 'TRANSFER_PAID', transferId, at: Date.now() },
    });

    await pushLedgerPair({
      title: `Compra • ${prop.name} • Dinheiro`,
      amount: prop.sellValue,
      fromUid: buyer.uid,
      fromName: buyer.name,
      toUid: uid,
      toName: me.name,
      kindPaid: 'compra',
      kindReceived: 'venda',
      meta: { type: 'PROP_TRANSFER', transferId, propId: prop.id, paymentMethod: 'cash' },
    });

    setTransferCashMsg('Dinheiro registrado. O bancário recebeu a confirmação para transferir a propriedade.');
    setTransferToUid('');
    playBeep('notif');
  }

  async function bankerConfirmPlayerTransfer() {
    if (!pendingTransfer) return;
    const trId = pendingTransfer.id;

    await runTransaction(ref(db, `${roomRefBase}`), (state: any) => {
      if (!state) return state;
      const tr = state.transfers?.[trId];
      if (!tr) return state;
      if (tr.status !== 'paid') return state;

      const props: PropertyItem[] = state.properties || [];
      const idx = props.findIndex((p) => p.id === tr.propId);
      if (idx >= 0) {
        props[idx].ownerUid = tr.toUid;
      }
      state.properties = props;

      tr.status = 'transferred';
      state.transfers[trId] = tr;

      return state;
    });

    setTransferPaidPopupOpen(false);
    setPendingTransfer(null);
  }


  async function liquidatePlayer(playerUid: string, status: 'falido' | 'desistente') {
    if (role !== 'bancario' || !room || playerUid === BANK_UID) return;
    const player = room.players?.[playerUid];
    if (!player) return;

    const label = status === 'falido' ? 'declarar falência' : 'registrar desistência';
    if (!window.confirm(`Deseja ${label} de ${player.name}? O saldo e todas as propriedades voltarão ao Banco.`)) return;

    const oldBalance = Math.max(0, Number(player.balance || 0));

    const result = await runTransaction(ref(db, `${roomRefBase}`), (state: any) => {
      if (!state?.players?.[playerUid]) return;

      const target = state.players[playerUid];
      target.status = status;
      target.balance = 0;
      target.debtToBank = 0;
      target.online = false;
      target.lastSeen = Date.now();

      const props: PropertyItem[] = state.properties || [];
      state.properties = props.map((prop) =>
        prop.ownerUid === playerUid
          ? { ...prop, ownerUid: BANK_UID, houses: 0, hasHotel: false, mortgaged: false }
          : prop
      );

      if (state.sales) {
        Object.values(state.sales).forEach((sale: any) => {
          if (sale?.buyerUid === playerUid && sale.status !== 'transferred') sale.status = 'cancelled';
        });
      }

      if (state.transfers) {
        Object.values(state.transfers).forEach((tr: any) => {
          if ((tr?.fromUid === playerUid || tr?.toUid === playerUid) && tr.status !== 'transferred') {
            tr.status = 'cancelled';
          }
        });
      }

      if (state.players[BANK_UID]) state.players[BANK_UID].balance = BANK_BALANCE;
      return state;
    });

    if (result.committed && oldBalance > 0) {
      await pushLedgerPair({
        title: status === 'falido' ? 'Liquidação por falência' : 'Encerramento por desistência',
        amount: oldBalance,
        fromUid: playerUid,
        fromName: player.name,
        toUid: BANK_UID,
        toName: BANK_NAME,
        kindPaid: 'ajuste',
        kindReceived: 'recebido',
        meta: { type: 'ACCOUNT_LIQUIDATION', status },
      });
    }
  }

  async function bankerBuyBackProperty(prop: PropertyItem) {
    if (role !== 'bancario' || !room || prop.ownerUid === BANK_UID) return;
    const owner = room.players?.[prop.ownerUid];
    if (!owner) return;
    const value = Math.max(0, Number(prop.sellValue || 0));

    if (!window.confirm(`Recomprar ${prop.name} de ${owner.name} por ${money(value)}?`)) return;

    const result = await runTransaction(ref(db, `${roomRefBase}`), (state: any) => {
      if (!state?.players?.[owner.uid]) return;
      const props: PropertyItem[] = state.properties || [];
      const idx = props.findIndex((p) => p.id === prop.id);
      if (idx < 0 || props[idx].ownerUid !== owner.uid) return;

      if (state.players[owner.uid].status === 'falido' || state.players[owner.uid].status === 'desistente') return;

      state.players[owner.uid].balance = (state.players[owner.uid].balance || 0) + value;
      props[idx] = { ...props[idx], ownerUid: BANK_UID, houses: 0, hasHotel: false, mortgaged: false };
      state.properties = props;
      if (state.players[BANK_UID]) state.players[BANK_UID].balance = BANK_BALANCE;
      return state;
    });

    if (result.committed) {
      await pushLedgerPair({
        title: `Recompra • ${prop.name}`,
        amount: value,
        fromUid: BANK_UID,
        fromName: BANK_NAME,
        toUid: owner.uid,
        toName: owner.name,
        kindPaid: 'compra',
        kindReceived: 'venda',
        meta: { type: 'BANK_BUYBACK', propId: prop.id },
      });
    }
  }

  /* ============ UI helpers ============ */
  function goTo(id: string) {
    if (id === 'ledger') setFocus('ledger');
    else if (id === 'props') setFocus('props');
    else if (id === 'pend') setFocus('pend');
    else setFocus('home');
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function logout() {
    try {
      if (roomRefBase && uid) {
        await update(ref(db, `${roomRefBase}/players/${uid}`), { online: false, lastSeen: Date.now() });
      }
    } catch {}
    localStorage.removeItem('uid');
    localStorage.removeItem('name');
    localStorage.removeItem('email');
    localStorage.removeItem('roomCode');
    localStorage.removeItem('role');
    router.push('/');
  }
async function finalizeGameNow() {
  setEndErr('');
  if (role !== 'bancario') return;

  if (!endWinnerUid) {
    setEndErr('Selecione o jogador ganhador.');
    return;
  }

  const winnerName = room?.players?.[endWinnerUid]?.name || 'Jogador';
  const winnerBalance = Number(room?.players?.[endWinnerUid]?.balance || 0);

  const winnerHouses = properties
    .filter((p) => p.ownerUid === endWinnerUid)
    .reduce((acc, p) => acc + (Number(p.houses || 0)), 0);

  try {
    await runTransaction(ref(db, `${roomRefBase}`), (state: any) => {
      if (!state) return state;
      state.players = state.players || {};

      if (state.players[endWinnerUid]) {
        state.players[endWinnerUid].status = 'vencedor';
      }

      state.gameEnded = {
        endedAt: Date.now(),
        endedByUid: uid,
        winnerUid: endWinnerUid,
        winnerName,
        winnerBalance,
        winnerHouses,
      };

      return state;
    });

    // fecha modal do bancário
    setEndConfirmStep(false);
    setEndWinnerUid('');
    setEndGameOpen(false);
  } catch (e) {
    setEndErr('Erro ao finalizar a partida.');
  }
}

  /* ============ RENDER ============ */
 if (!room || !me) {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        background: '#f2f2f7',
      }}
    >
      <div
        style={{
          width: 220,
          padding: '18px 16px',
          borderRadius: 18,
          background: 'rgba(255, 255, 255, 0.92)',
          boxShadow: '0 18px 50px rgba(0, 0, 0, 0.18)',
          display: 'grid',
          justifyItems: 'center',
        }}
      >
        <div
          style={{
            width: 78,
            height: 78,
            position: 'relative',
            display: 'grid',
            placeItems: 'center',
          }}
        >
          {/* anel girando (sem CSS externo) */}
          <svg
            width="96"
            height="96"
            viewBox="0 0 100 100"
            style={{ position: 'absolute' }}
            aria-hidden="true"
          >
            <circle
              cx="50"
              cy="50"
              r="38"
              fill="none"
              stroke="rgba(11, 93, 74, 0.2)"
              strokeWidth="8"
            />
            <circle
              cx="50"
              cy="50"
              r="38"
              fill="none"
              stroke="rgba(11, 93, 74, 1)"
              strokeWidth="8"
              strokeLinecap="round"
              strokeDasharray="60 200"
            >
              <animateTransform
                attributeName="transform"
                type="rotate"
                from="0 50 50"
                to="360 50 50"
                dur="0.9s"
                repeatCount="indefinite"
              />
            </circle>
          </svg>

          {/* sua logo */}
          <img
            src="/favicon.ico"
            alt="Logo"
            style={{
              width: 44,
              height: 44,
              borderRadius: 12,
              background: '#fff',
              padding: 6,
              border: '1px solid rgba(0,0,0,.08)',
            }}
          />
        </div>
      </div>
    </div>
  );
}

  const availableList = showAllProps ? availableProps : availableProps.slice(0, 3);
  const soldList = showAllProps ? propsAll.filter((p) => p.ownerUid !== BANK_UID) : propsAll.filter((p) => p.ownerUid !== BANK_UID).slice(0, 3);
  const myList = showAllProps ? myProps : myProps.slice(0, 3);
function rentComparable(p: PropertyItem) {
  // pra ordenar por aluguel (mais caro/mais barato)
  if (p.kind === 'MULTIPLIER') return Number(p.multiplierValue || 0);
  return Number(p.baseRent || 0);
}

function matchesQuery(p: PropertyItem, q: string) {
  if (!q) return true;
  const s = q.trim().toLowerCase();
  return (
    (p.name || '').toLowerCase().includes(s) ||
    (p.colorName || '').toLowerCase().includes(s)
  );
}


  return (
    <main className="wrap">
      <header className="header">
        <div className="hTop">
 <button
  type="button"
  className="avatarLogo"
  onClick={() => setFocus('home')}
  title="Voltar para Home"
>
  <img
    src="/favicon.ico"
    alt="Logo"
    onError={(e) => {
      const img = e.currentTarget as HTMLImageElement;
      img.style.display = 'none';
      const parent = img.parentElement;
      if (parent) parent.classList.add('avatarFallback');
    }}
  />
  <span className="avatarBL">BL</span>
</button>
 <div className="iconsCol">
  <div className="iconsRow">
    <button
      className="iconBtn bellBtn"
      onClick={() => {
        setNotifOpen(true);
        setNotifUnread(0);
      }}
      aria-label="Notificações"
      type="button"
    >
      🔔
      {notifUnread > 0 && <span className="badge">{notifUnread > 99 ? '99+' : notifUnread}</span>}
    </button>

    <button className="iconBtn" onClick={logout}>
      Sair
    </button>
  </div>

  {role === 'bancario' && (
    <button className="iconBtn dangerBtn" type="button" onClick={() => setEndGameOpen(true)}>
      Finalizar partida
    </button>
  )}
</div>
        </div>

        <div className="hello">{role === 'bancario' ? 'Painel do Banco' : `Olá, ${name}`}</div>
        <div className="sub">
          Banco Imobiliário Pay • Sala <b>{roomCode}</b> • {role === 'bancario' ? 'Operador do Banco' : 'Conta da partida'}
        </div>
        <div className="gameOnly">AMBIENTE DE JOGO • SEM DINHEIRO REAL</div>
      </header>

      <section className="page">
        {/* CONTA */}
        <div className="card" id="conta">
          <div className="row">
            

            <div>
              <div className="label">{role === 'bancario' ? 'Caixa do Banco' : 'Conta da partida'}</div>
              <div className="balRow"><div className={"balance" + (hideBalance ? " blur" : "")}>{role === 'bancario' ? '∞' : money(me.balance)}</div>
              <button type="button" className="eyeBtn" onClick={() => setHideBalance((v) => !v)}>{hideBalance ? "👁️" : "👁️‍🗨️"}
              </button>
              </div>
              {isBlocked && role === 'jogador' && (
                <div className="blocked">Você está preso. Você NÃO consegue “Receber”. Só o bancário libera com Habeas ou Fiança.</div>
              )}
              {isClosed && role === 'jogador' && (
                <div className="blocked">
                  Conta encerrada por {me.status === 'falido' ? 'falência' : 'desistência'}. Saldo e propriedades foram liquidados para o Banco.
                </div>
              )}
            
                          {/* PENDÊNCIAS / PARCELAS */}
              {focus === 'pend' && (pendingSales.length > 0 || pendingBankPropertyTransfers.length > 0) && (
                <div className="pendBox">
                  <div className="pendTitle">Pendências</div>
                  <div className="pendHint">
                    {role === 'bancario'
                      ? 'Parcelas pendentes dos jogadores. Pix e dinheiro continuam disponíveis.'
                      : 'Compras e transferências pendentes. Você pode pagar por transferência bancária direto pela sua conta.'}
                  </div>

                  <div className="pendList">
                    {pendingSales.map((s: any) => {
                      const inst = Math.max(1, Number(s?.installments || 1));
                      const paidArr: boolean[] = Array.isArray(s?.paidInstallments) ? s.paidInstallments : Array(inst).fill(false);
                      const paidCount = paidArr.filter(Boolean).length;
                      const nextIdx = paidArr.findIndex((v) => !v);
                      const per = saleInstallmentAmount(s, Math.max(0, nextIdx));

                      return (
                        <div key={s.id} className="pendItem">
                          <div className="pendRow">
                            <div className="pendMain">
                              <div className="pendName">{s.propName}</div>
                              <div className="pendSub">
                                {role === 'bancario' ? (
                                  <span>
                                    <b>{s.buyerName}</b> • {paidCount}/{inst} pagas • próxima {money(per)}
                                  </span>
                                ) : (
                                  <span>
                                    {paidCount}/{inst} pagas • próxima {money(per)}
                                  </span>
                                )}
                              </div>
                            </div>

                            {role === 'bancario' && nextIdx >= 0 && (
                              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                                <button className="miniBtn" onClick={() => openNextInstallmentQr(s)}>
                                  Pix
                                </button>
                                <button className="miniBtn" onClick={() => receiveNextInstallmentCash(s as SaleDoc)}>
                                  Dinheiro
                                </button>
                              </div>
                            )}
                            {role === 'jogador' && nextIdx >= 0 && (
                              <button className="miniBtn" onClick={() => paySaleByBankTransfer(s as SaleDoc)}>
                                Transferência
                              </button>
                            )}
                          </div>

                          <div className="pendBar">
                            <div className="pendBarFill" style={{ width: `${Math.round((paidCount / inst) * 100)}%` }} />
                          </div>

                          <div className="pendDots" aria-label="Parcelas">
                            {Array.from({ length: inst }).map((_, i) => {
                              const paid = !!paidArr[i];
                              const isNext = i === nextIdx;
                              return (
                                <div
                                  key={`${s.id}-dot-${i}`}
                                  className={`pendDot ${paid ? 'on' : ''} ${isNext ? 'next' : ''}`}
                                  title={paid ? `Parcela ${i + 1} paga` : `Parcela ${i + 1} pendente`}
                                >
                                  {i + 1}
                                </div>
                              );
                            })}
                          </div>


                          {nextIdx >= 0 ? (
                            <div className="pendNext">
                              Próxima: <b>Parcela {nextIdx + 1}/{inst}</b> ({money(per)})
                            </div>
                          ) : (
                            <div className="pendNext ok">Tudo pago ✅</div>
                          )}
                        </div>
                      );
                    })}

                    {pendingBankPropertyTransfers.map((tr) => (
                      <div key={tr.id} className="pendItem">
                        <div className="pendRow">
                          <div className="pendMain">
                            <div className="pendName">{tr.propName}</div>
                            <div className="pendSub">
                              Compra de <b>{tr.fromName}</b> • {money(tr.amount)}
                            </div>
                          </div>
                          <button className="miniBtn" onClick={() => payPropertyByBankTransfer(tr)}>
                            Pagar transferência
                          </button>
                        </div>
                        <div className="pendNext">A propriedade é transferida pelo bancário após a confirmação do pagamento.</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
</div>
            <button className="chevBtn" onClick={() => goTo('ledger')} title="Ir para Extrato">
              <span className="chev">›</span>
            </button>
          </div>

          <div className="actions">
            <button
              className={`act ${role === 'jogador' && isClosed ? 'disabled' : ''}`}
              disabled={role === 'jogador' && isClosed}
              onClick={() => {
                if (role === 'bancario') {
                  setBankPayMenuOpen((v) => !v);
                } else {
                  openPay();
                }
              }}
            >
              <span className="ico">
                <IconPay />
              </span>
              <span>Pagar com Pix</span>
            </button>


            {showReceive ? (
              <button
                className="act"
                onClick={() => {
                  setRcvTitle('Recebimento');
                  setRcvAmount(200000);
                  setRcvAmountText(money(200000));
                  setGeneratedCode('');
                  setQrDataUrl('');
                  setReceiveOpen(true);
                }}
              >
                <span className="ico">
                  <IconReceive />
                </span>
                <span>Receber com Pix</span>
              </button>
            ) : (
              <button className="act disabled" disabled title="Preso">
                <span className="ico">
                  <IconReceive />
                </span>
                <span>Receber</span>
              </button>
            )}

<button
  className={`act ${role === 'jogador' && isClosed ? 'disabled' : ''}`}
  disabled={role === 'jogador' && isClosed}
  onClick={() => {
    setTxTitle('Transferência');
    setTxAmount(0);
    setTxAmountText(money(0));
    setTxToUid('');
    setTxErr('');
    setTxOpen(true);
  }}
>
  <span className="ico">
    <IconPix />
  </span>
  <span>Transferir</span>
</button>


            <button className="act" onClick={() => goTo('props')}>
              <span className="ico">
                <IconProps />
              </span>
              <span>Propriedades</span>
            </button>

            <button className="act" onClick={() => goTo('ledger')}>
              <span className="ico">
                <IconPix />
              </span>
              <span>Extrato</span>
            </button>
            <button className="act" onClick={() => goTo('pend')}>
              <span className="ico">
                <IconProps />
              </span>
              <span>Pendências</span>
            </button>

          </div>
        </div>

        {/* ADMIN: bancário */}
        {role === 'bancario' && (
          <div className="card" id="admin" style={{ display: focus === 'home' ? 'block' : 'none' }}>
            <div className="row">
              <div>
                <div className="label">Jogadores na sala</div>
                <div className="hint">Só o bancário vê online/offline. Prender abre o fluxo de Habeas/Fiança.</div>
              </div>
              <button className="chevBtn" onClick={() => goTo('props')} title="Ir para Propriedades">
                <span className="chev">›</span>
              </button>
            </div>

            <div className="adminList">
              {playersArr
                .filter((p) => p.uid !== bankerUid)
                .map((p) => (
                  <div key={p.uid} className="adminRow">
                    <div className="adminLeft">
                      <div className="adminName">
                        {p.name}{' '}
                        <span className={p.online ? 'dot on' : 'dot off'} title={p.online ? 'Online' : 'Offline'} />
                      </div>
                      <div className="adminMeta">
                        {money(p.balance)} • status: <b>{p.status}</b>
                      </div>
                    </div>
                    <div className="adminBtns">
                      <button
                        className="pillBtn ghost"
                        onClick={async () => {
                          if (p.status !== 'preso') {
                            // Prender: só atualiza o status (sem popup pro bancário)
                            await update(ref(db, `${roomRefBase}/players/${p.uid}`), { status: 'preso' });
                            return;
                          }
                          // Desbloquear: abre o fluxo (Habeas/Taxa). Só libera depois da escolha.
                          setJailTargetUid(p.uid);
                          setJailFlowOpen(true);
                        }}
                      >
                        {p.status === 'preso' ? 'Desbloquear' : 'Prender'}
                      </button>
                      <button
                        className="pillBtn danger"
                        onClick={() => liquidatePlayer(p.uid, 'falido')}
                        disabled={p.status === 'falido' || p.status === 'desistente'}
                      >
                        Falência
                      </button>
                      <button
                        className="pillBtn ghost"
                        onClick={() => liquidatePlayer(p.uid, 'desistente')}
                        disabled={p.status === 'falido' || p.status === 'desistente'}
                      >
                        Desistiu
                      </button>
                    </div>
                  </div>
                ))}
            </div>
          </div>
        )}

        {/* PROPRIEDADES */}
        <div id="props" style={{ display: focus === 'props' ? 'block' : 'none' }} className="card">
          <div className="row">
            <div>
              <div className="label">Propriedades</div>
              <div className="hint">
                {role === 'bancario'
                  ? 'Bancário vê todas as propriedades e administra compra, venda e recompra.'
                  : 'Use os filtros para alternar entre seus imóveis e os imóveis disponíveis no Banco.'}
              </div>
            </div>
            <button className="chevBtn" onClick={() => setShowAllProps((v) => !v)} title="Ver mais/menos">
              <span className="chev">{showAllProps ? '–' : '›'}</span>
            </button>
          </div>

{role === 'jogador' && (
  <div className="propViewTabs" role="tablist" aria-label="Filtro de propriedades">
    <button
      type="button"
      className={propView === 'mine' ? 'propViewBtn active' : 'propViewBtn'}
      onClick={() => { setPropView('mine'); setShowAllProps(false); }}
    >
      Minhas propriedades <span>{propsAll.filter((p) => p.ownerUid === uid).length}</span>
    </button>
    <button
      type="button"
      className={propView === 'sale' ? 'propViewBtn active' : 'propViewBtn'}
      onClick={() => { setPropView('sale'); setShowAllProps(false); }}
    >
      À venda <span>{propsAll.filter((p) => p.ownerUid === BANK_UID).length}</span>
    </button>
  </div>
)}

<div className="propFilters">
  <input
    className="propSearch"
    value={propQuery}
    onChange={(e) => setPropQuery(e.target.value)}
    placeholder="Buscar por nome (ex: Paulista, Jardins...)"
  />

  <select
    className="propSelect"
    value={propColor}
    onChange={(e) => setPropColor(e.target.value)}
  >
    <option value="all">Todas as cores</option>
    {Array.from(new Set((propsAll || []).map(p => (p.colorName || '').trim()).filter(Boolean)))
      .sort((a, b) => a.localeCompare(b))
      .map((c) => (
        <option key={c} value={c}>{c}</option>
      ))}
  </select>

  <select
    className="propSelect"
    value={propSort}
    onChange={(e) => setPropSort(e.target.value as any)}
  >
    <option value="none">Sem ordenação</option>
    <option value="rent_desc">Aluguel mais caro</option>
    <option value="rent_asc">Aluguel mais barato</option>
    <option value="mort_desc">Hipoteca mais cara</option>
    <option value="mort_asc">Hipoteca mais barata</option>
  </select>

  <button
    className="propClear"
    type="button"
    onClick={() => {
      setPropQuery('');
      setPropColor('all');
      setPropSort('none');
    }}
  >
    Limpar
  </button>
</div>

          
          <div className="row2">
            <div className="sectionTitle">{role === 'jogador' ? (propView === 'mine' ? 'Minhas propriedades' : 'Propriedades à venda') : 'Propriedades'}</div>
            <button className="linkBtn" onClick={() => setShowAllProps((v) => !v)}>
              {showAllProps ? 'Mostrar só 3' : 'Ver todas'}
            </button>
          </div>

          <div className="propGrid">
            {(() => {
              if (propsFilteredSorted.length === 0)
  return <div className="empty">{role === 'jogador' && propView === 'mine' ? 'Você ainda não possui propriedades.' : role === 'jogador' ? 'Nenhuma propriedade disponível para venda com esse filtro.' : 'Nenhuma propriedade encontrada com esse filtro.'}</div>;

              const list = showAllProps ? propsFilteredSorted : propsFilteredSorted.slice(0, 3);
              return list.map((p) => {
                const sold = p.ownerUid !== BANK_UID;
                const isMine = role === 'jogador' && p.ownerUid === uid;
                const ownerName = sold ? (room.players?.[p.ownerUid]?.name || 'Jogador') : BANK_NAME;
                                       
                return (
                  <div key={p.id} className="pWrap">
                    <div className="pMiniCard">
                      <div className={isMine ? 'ribbon ok' : sold ? 'ribbon bad' : 'ribbon ok'}>
  <span className="ribbonText">
    {isMine ? 'MINHA PROPRIEDADE' : sold ? `PROPRIEDADE VENDIDA • Dono: ${ownerName}` : 'DISPONÍVEL PARA VENDA'}
  </span>
</div>


                      <div className="pMiniTop">TÍTULO DE POSSE</div>

                      <div className="pBand" style={{ background: p.colorHex || '#f0a22e' }}>
                        <div className="pBandName">{p.name}</div>
                        <div className="pBandRow">
                          <span>HIPOTECA</span>
                          <span>{money(p.price)}</span>
                        </div>
                      </div>

                      <div className="pOwner center">
                        <span className="key">🔑</span>
                        <span>
                          <b>Proprietário atual:</b> {ownerName}
                        </span>
                      </div>
                    </div>

                    <div className="pBtnsOut">
  <button
    className="pBtn ghost"
    type="button"
    onClick={() => {
      setViewProp(p);
      setViewPropOpen(true);
    }}
  >
    VISUALIZAR
  </button>

  {role === 'bancario' ? (
  sold ? (
    <button
      className="pBtn ghost"
      type="button"
      title="Banco recompra a propriedade pelo valor de venda"
      onClick={() => bankerBuyBackProperty(p)}
    >
      RECOMPRAR
    </button>
  ) : (
    <button
      className="pBtn"
      type="button"
      title="Vender para jogador (gera Pix)"
      onClick={() => openSell(p.id)}
    >
      VENDER
    </button>
  )
) : isMine ? (
  <button
    className="pBtn"
    type="button"
    onClick={() => openRent(p.id)}
    title="Cobrar aluguel, vender ou transferir esta propriedade"
  >
    GERENCIAR
  </button>
) : (
  <button className="pBtn disabled" type="button" disabled>
    DISPONÍVEL NO BANCO
  </button>
)}

</div>


                  </div>                );
              });
            })()}
          </div>

        </div>

        {/* EXTRATO */}
        <div id="ledger" className="card">
          <div className="row">
            <div>
              <div className="label">Extrato</div>
              <div className="hint">{role === 'bancario' ? 'Você vê tudo (banco + jogadores).' : 'Você vê apenas suas movimentações.'}</div>
            </div>
            <button className="chevBtn" onClick={() => goTo('conta')} title="Voltar ao topo">
              <span className="chev">›</span>
            </button>
          </div>

          <div className="ledger">
            {filteredLedger.length === 0 && <div className="empty">Sem movimentações.</div>}
            {filteredLedger.slice(0, 80).map((l) => (
              <div key={l.id} className="lRow">
                <div className="lLeft">
                  <div className="lTitle">{l.title}</div>
                  <div className="lSub">
                    {new Date(l.at).toLocaleString('pt-BR')}
                    {l.from && l.to ? ` • ${l.from} → ${l.to}` : ''}
                    {l.meta?.meta?.paymentMethod === 'cash' ? ' • Dinheiro' : l.meta?.meta?.paymentMethod === 'pix' ? ' • Pix' : ''}
                  </div>
                </div>
                <div className={l.amount >= 0 ? 'lAmt pos' : 'lAmt neg'}>{money(l.amount)}</div>
              </div>
            ))}
          </div>
        </div>
      </section>


      {/* ===== MODAL LER QR (câmera) ===== */}
      <Modal
        open={scanCamOpen}
        title="Ler QR Code (Pix)"
        onClose={() => {
          setScanCamOpen(false);
          setCamError('');
        }}
      >
        <QrCam
          onCode={(code) => {
            setScanText(code);
            setScanCamOpen(false);
            setPayOpen(false);
            // Valida o valor capturado diretamente; evita usar scanText antigo após setState.
            previewPaymentCode(code);
          }}
          onFallback={() => {
            setScanCamOpen(false);
            setPayOpen(true);
          }}
          onError={(msg) => setCamError(msg)}
        />
        {camError && <div className="err" style={{ marginTop: 10 }}>{camError}</div>}
      </Modal>

      
      {/* ===== MODAL: O que o bancário vai pagar? ===== */}
      <Modal
        open={role === 'bancario' && bankPayMenuOpen}
        title="O que o bancário vai pagar?"
        onClose={() => setBankPayMenuOpen(false)}
      >
        <div className="bankPayGrid">
          <button
            className="bankPayCard"
            onClick={() => {
              setBankPayMenuOpen(false);
              openPay('Taxa inicial');
            }}
          >
            <div className="bankPayName">Taxa inicial</div>
            <div className="bankPayDesc">Pagar taxa / início</div>
          </button>

          <button
            className="bankPayCard"
            onClick={() => {
              setBankPayMenuOpen(false);
              openPay('Carta Sorte/Revés');
            }}
          >
            <div className="bankPayName">Carta Sorte/Revés</div>
            <div className="bankPayDesc">Pagar ao jogador</div>
          </button>

          <button
            className="bankPayCard"
            onClick={() => {
              setBankPayMenuOpen(false);
              openPay('Imposto');
            }}
          >
            <div className="bankPayName">Imposto</div>
            <div className="bankPayDesc">Pagamento de imposto</div>
          </button>

          <button
            className="bankPayCard"
            onClick={() => {
              setBankPayMenuOpen(false);
              openPay('Outros');
            }}
          >
            <div className="bankPayName">Outros</div>
            <div className="bankPayDesc">Qualquer pagamento</div>
          </button>
        </div>

        <div className="bankPayHint">
          Depois de escolher, a câmera abre para ler o QR do <b>Receber</b> do jogador (ou você pode colar o código).
        </div>
      </Modal>

{/* ===== MODAL PAGAR ===== */}
      <Modal open={payOpen} title={payReason ? `Pagar — ${payReason}` : "Pagar (QR Code)"} onClose={() => setPayOpen(false)}>
        <div className="mHint">
          Cole o código <b>BI|...</b> do QR.
        </div>

        <div className="field">
          <div className="lab">Código</div>
          <textarea className="ta" rows={4} value={scanText} onChange={(e) => setScanText(e.target.value)} placeholder="Cole aqui o BI|...." />
        </div>

        <button className="btn" onClick={parseAndPreview} disabled={!scanText.trim()}>
          Continuar
        </button>

        {scanError && <div className="err">{scanError}</div>}
      </Modal>


{/* ===== MODAL: TRANSAÇÃO ONLINE (sem QR) ===== */}
<Modal
  open={txOpen}
  title="Transferência bancária"
  onClose={() => {
    setTxOpen(false);
    setTxErr('');
  }}
>
  <div className="field">
    <div className="lab">Para</div>
    <select className="inp" value={txToUid} onChange={(e) => setTxToUid(e.target.value)}>
      <option value="">Selecione um jogador.</option>
      {playersArr
        .filter((p) => p.uid !== uid)
        .map((p) => (
          <option key={p.uid} value={p.uid}>
            {p.name}
          </option>
        ))}
    </select>
  </div>

  <div className="field">
    <div className="lab">Motivo</div>
    <input className="inp" value={txTitle} onChange={(e) => setTxTitle(e.target.value)} placeholder="Ex: Pix, acerto da rodada, negociação" />
  </div>

<div className="field">
  <div className="lab">Valor</div>

  <input
    className="inp"
    inputMode="decimal"
    value={txAmountText}
    onFocus={(e) => e.currentTarget.select()}
    onChange={(e) => {
      const n = parseMoneyTyping(e.target.value);
      setTxAmount(n);
      setTxAmountText(n > 0 ? moneyTyping(n) : '');
    }}
    onBlur={() => {
      if (txAmount > 0) setTxAmountText(money(txAmount));
      else setTxAmountText('');
    }}
    placeholder="R$ 0,00"
  />

  <button className="btn primary" onClick={openOnlineTransfer}>
    Transferir agora
  </button>

  {txErr && <div className="err">{txErr}</div>}
</div> {/* <<< FALTAVA ISSO */}
</Modal>

      {/* ===== MODAL CONFIRMAR PAGAMENTO ===== */}
      <Modal
        open={confirmOpen}
        title="Confirmar pagamento"
        onClose={() => {
          setConfirmOpen(false);
          setPayloadToPay(null);
          }}
      >
        {!payloadToPay ? (
          <div className="empty">Nenhum pagamento selecionado.</div>
        ) : (
          <>
            <div className="sum">
              <div className="li2">
                <span>Para</span>
                <b>{payloadToPay.toName}</b>
              </div>
              <div className="li2">
                <span>Motivo</span>
                <b>{payloadToPay.title}</b>
              </div>
              <div className="li2">
                <span>Valor</span>
                <b>{money(payloadToPay.amount)}</b>
              </div>
            </div>

{confirmError && <div className="err">{confirmError}</div>}

<button className="btn primary" onClick={confirmPay} disabled={busy}>
  {busy ? 'Processando...' : 'Confirmar'}
</button>
          </>
        )}
      </Modal>

      <Modal
        open={receiptOpen}
        title="Pix realizado"
        onClose={() => setReceiptOpen(false)}
      >
        {lastReceipt && (
          <div className="receipt">
            <div className="receiptOk">✓</div>
            <div className="receiptTitle">Pagamento concluído</div>
            <div className="receiptAmount">{money(lastReceipt.amount)}</div>
            <div className="sum">
              <div className="li2"><span>De</span><b>{lastReceipt.fromName}</b></div>
              <div className="li2"><span>Para</span><b>{lastReceipt.toName}</b></div>
              <div className="li2"><span>Descrição</span><b>{lastReceipt.title}</b></div>
              <div className="li2"><span>Data</span><b>{new Date(lastReceipt.at).toLocaleString('pt-BR')}</b></div>
              <div className="li2"><span>ID</span><b className="receiptId">{lastReceipt.id}</b></div>
            </div>
            <div className="mHint">Comprovante da partida. Nenhum dinheiro real foi movimentado.</div>
            <button className="btn primary" onClick={() => setReceiptOpen(false)}>Concluir</button>
          </div>
        )}
      </Modal>

      {/* ===== MODAL RECEBER ===== */}
      <Modal
        open={receiveOpen}
        title={rcvTitle || "Receber (gera QR Code)"}
        onClose={() => {
          setReceiveOpen(false);
          setGeneratedCode('');
          setQrDataUrl('');
        }}
      >
        <div className="field">
          <div className="lab">Descrição</div>
          <input className="inp" value={rcvTitle} onChange={(e) => setRcvTitle(e.target.value)} placeholder="Ex: aluguel / taxa / etc..." />
        </div>

<div className="field">
  <div className="lab">Valor</div>

  <input
    className="inp"
    inputMode="decimal"
    value={rcvAmountText}
    onFocus={(e) => e.currentTarget.select()}
    onChange={(e) => {
      const n = parseMoneyTyping(e.target.value);
      setRcvAmount(n);
      setRcvAmountText(n > 0 ? moneyTyping(n) : '');
    }}
    onBlur={() => {
      if (rcvAmount > 0) setRcvAmountText(money(rcvAmount));
      else setRcvAmountText('');
    }}
    placeholder="R$ 0,00"
  />

  <button className="btn primary" onClick={clickGenerateReceive}>
    Gerar QR
  </button>

  {qrDataUrl && (
    <div className="qrBox">
      <img className="qrImg" src={qrDataUrl} alt="QR Code" />
      <div className="rowBtn">
        <button className="btn" onClick={() => copy(generatedCode)}>
          Copiar (fallback)
        </button>
      </div>
      <div className="mHint">
        O pagador abre <b>Pagar</b> e cola o código do QR.
      </div>
    </div>
  )}
</div> {/* ✅ FECHA O field */}
</Modal>
    {/* ===== MODAL VENDER PROPRIEDADE (BANCÁRIO) ===== */}
<Modal
  open={sellOpen}
  title="Vender propriedade"
  onClose={() => {
    setSellOpen(false);
    setSellPropId('');
    setSellToUid('');
    setSellMode('avista');
    setSellPaymentMethod('pix');
    setSellInstallments(2);
    setSellQr('');
    setSellCode('');
    setSellCashMsg('');
  }}
>
          {(() => {
          const propsArr = Array.isArray((room as any)?.properties) ? (room as any).properties : Object.values((room as any)?.properties || {});
          const prop = (propsArr as any[]).find((p: any) => p?.id === sellPropId);
          if (!prop) return <div className="empty">Propriedade não encontrada.</div>;

          return (
  <div className="sellFit">
    <div className="sum">
                <div className="li2">
                  <span>Imóvel</span>
                  <b style={{ color: prop.colorHex }}>{prop.name}</b>
                </div>
                <div className="li2">
                  <span>Hipoteca</span>
                  <b>{money(prop.price)}</b>
                </div>
              </div>

              <div className="field">
                <div className="lab">Vender para</div>
                <select className="inp" value={sellToUid} onChange={(e) => setSellToUid(e.target.value)}>
                  <option value="">Selecione um jogador...</option>
                  {playersArr
                    .filter((p) => p.uid !== bankerUid && p.uid !== BANK_UID && p.status !== 'falido' && p.status !== 'desistente')
                    .map((p) => (
                      <option key={p.uid} value={p.uid}>
                        {p.name}
                      </option>
                    ))}
                </select>
              </div>

              <div className="field">
                <div className="lab">Forma de pagamento</div>
                <div className="seg2">
                  <button
                    className={sellPaymentMethod === 'pix' ? 'segBtn active' : 'segBtn'}
                    onClick={() => { setSellPaymentMethod('pix'); setSellCashMsg(''); setSellQr(''); setSellCode(''); }}
                    type="button"
                  >
                    Pix
                  </button>
                  <button
                    className={sellPaymentMethod === 'bank_transfer' ? 'segBtn active' : 'segBtn'}
                    onClick={() => { setSellPaymentMethod('bank_transfer'); setSellCashMsg(''); setSellQr(''); setSellCode(''); }}
                    type="button"
                  >
                    Transferência
                  </button>
                  <button
                    className={sellPaymentMethod === 'cash' ? 'segBtn active' : 'segBtn'}
                    onClick={() => { setSellPaymentMethod('cash'); setSellCashMsg(''); setSellQr(''); setSellCode(''); }}
                    type="button"
                  >
                    Dinheiro
                  </button>
                </div>
                <div className="mHint">
                  {sellPaymentMethod === 'cash'
                    ? 'Dinheiro físico só registra a operação; não altera o saldo digital.'
                    : sellPaymentMethod === 'bank_transfer'
                    ? 'O comprador confirma a transferência na própria conta, em Pendências.'
                    : 'O comprador escaneia o Pix e confirma o pagamento.'}
                </div>
              </div>

              <div className="field">
                <div className="lab">Condição</div>
                <div className="seg2">
                  <button className={sellMode === 'avista' ? 'segBtn active' : 'segBtn'} onClick={() => setSellMode('avista')} type="button">
                    À vista
                  </button>
                  <button className={sellMode === 'parcelado' ? 'segBtn active' : 'segBtn'} onClick={() => setSellMode('parcelado')} type="button">
                    Parcelado
                  </button>
                </div>
              </div>

              {sellMode === 'parcelado' && (
                <div className="field">
                  <div className="lab">Em quantas vezes? (2 a 6)</div>
                  <select className="inp" value={sellInstallments} onChange={(e) => setSellInstallments(Number(e.target.value))}>
                    {[2, 3, 4, 5, 6].map((n) => (
                      <option key={n} value={n}>
                        {n}x
                      </option>
                    ))}
                  </select>
                  <div className="mHint">
                    Vai ficar <b>{Math.min(6, Math.max(2, sellInstallments))}x</b> de{' '}
                    <b>{money(installmentAmount(prop.price, Math.min(6, Math.max(2, sellInstallments)), 0))}</b>.
                  </div>

                </div>
              )}

              <button className="btn primary" onClick={generateSellQr} disabled={sellBusy || !sellToUid}>
                {sellPaymentMethod === 'cash'
                  ? sellMode === 'avista'
                    ? 'Registrar pagamento em dinheiro'
                    : 'Registrar 1ª parcela em dinheiro'
                  : sellPaymentMethod === 'bank_transfer'
                  ? sellMode === 'avista'
                    ? 'Criar transferência bancária'
                    : 'Criar compra parcelada por transferência'
                  : sellMode === 'avista'
                  ? 'Gerar Pix à vista'
                  : 'Gerar Pix da 1ª parcela'}
              </button>
              {sellErr && <div className="err">{sellErr}</div>}
              {sellCashMsg && <div className="mHint" style={{ marginTop: 8 }}><b>{sellCashMsg}</b></div>}

              {sellBusy && <div className="mHint">Gerando QR...</div>}
              
              {(sellQr || sellCode) && (
  <div className="qrBox sellQrBox" style={{ marginTop: 10 }}>
    {sellQr ? (
      <img className="qrImg sellQrImg" src={sellQr} alt="QR da venda" />
    ) : (
      <div className="qrFallback">QR indisponível. Use o código abaixo.</div>
    )}

    <div className="copyRow">
      <button
        type="button"
        className="copyIconBtn"
        aria-label="Copiar código"
        title="Copiar código"
        onClick={() => copy(sellCode)}
      >
        <IconCopy />
      </button>

      <input
        className="pixInput"
        value={sellCode}
        readOnly={false}
        onChange={(e) => setSellCode(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onClick={(e) => (e.currentTarget as HTMLInputElement).select()}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
      />
    </div>

    <div className="mHint" style={{ textAlign: 'center' }}>
      O jogador paga pelo QR. Ao terminar, aparece popup para transferir.
    </div>
  </div>
)}

                        </div>
          );

        })()}
      </Modal>

           {/* ===== POPUP: pagou tudo, transferir? (banco -> jogador) ===== */}
      <Modal
        open={paidPopupOpen}
        title="Pagamento concluído (Propriedade paga)"
        onClose={() => {
          setPaidPopupOpen(false);
          setPendingTransferSale(null);
        }}
      >
        {!pendingTransferSale ? (
          <div className="empty">Nada pendente.</div>
        ) : (
          <>
            <div className="sum">
              <div className="li2">
                <span>Jogador</span>
                <b>{pendingTransferSale.buyerName}</b>
              </div>
              <div className="li2">
                <span>Propriedade</span>
                <b>{pendingTransferSale.propName}</b>
              </div>
              <div className="li2">
                <span>Total</span>
                <b>{money(pendingTransferSale.total)}</b>
              </div>
              <div className="li2">
                <span>Status</span>
                <b>Pago • Transferir?</b>
              </div>
            </div>

            <button className="btn primary" onClick={confirmTransferNow}>
              Sim, transferir agora
            </button>
            <button
              className="btn"
              onClick={() => {
                setPaidPopupOpen(false);
                setPendingTransferSale(null);
              }}
            >
              Não agora
            </button>
          </>
        )}
      </Modal>

      {/* ===== MODAL: CADEIA (bancário) ===== */}
      <Modal
        open={jailFlowOpen}
        title="Jogador preso"
        onClose={() => {
          setJailFlowOpen(false);
          setJailTargetUid('');
          setBailQrUrl('');
          setBailCode('');
          setBailQrOpen(false);
        }}
      >
        {!jailTargetUid ? (
          <div className="empty">Nenhum jogador selecionado.</div>
        ) : (
          <>
            <div className="sum">
              <div className="li2">
                <span>Jogador</span>
                <b>{room.players?.[jailTargetUid]?.name || 'Jogador'}</b>
              </div>
              <div className="li2">
                <span>Opções</span>
                <b>Habeas Corpus (grátis) ou Fiança</b>
              </div>
            </div>

            <button className="btn primary" onClick={() => jailHabeas(jailTargetUid)}>
              Habeas Corpus (liberar grátis)
            </button>

            <button className="btn" onClick={() => jailGenerateBailQr(jailTargetUid)}>
              Gerar QR da fiança ({money(BAIL_AMOUNT)})
            </button>

            {bailQrUrl && (
              <div className="qrBox">
                <img className="qrImg" src={bailQrUrl} alt="QR de fiança" />
                <div className="rowBtn">
                  <button className="btn" onClick={() => copy(bailCode)}>
                    Copiar (fallback)
                  </button>
                </div>
                <div className="mHint">O jogador paga pelo QR (senha obrigatória). Depois aparece popup “pagou?” para liberar.</div>
              </div>
            )}
          </>
        )}
      </Modal>

      {/* ===== POPUP: FIANÇA PAGA -> liberar? (bancário) ===== */}
      <Modal
        open={bailPaidPopupOpen}
        title="Fiança paga"
        onClose={() => {
          setBailPaidPopupOpen(false);
          setBailPaidPrisonerUid('');
        }}
      >
        {!bailPaidPrisonerUid ? (
          <div className="empty">Nada pendente.</div>
        ) : (
          <>
            <div className="sum">
              <div className="li2">
                <span>Jogador</span>
                <b>{room.players?.[bailPaidPrisonerUid]?.name || 'Jogador'}</b>
              </div>
              <div className="li2">
                <span>Status</span>
                <b>Pagamento confirmado • Liberar?</b>
              </div>
            </div>

            <button className="btn primary" onClick={() => bankerUnlockAfterBail(bailPaidPrisonerUid)}>
              Sim, liberar agora
            </button>
            <button className="btn" onClick={() => setBailPaidPopupOpen(false)}>
              Não agora
            </button>
          </>
        )}
      </Modal>

      {/* ===== MODAL: ALUGUEL (jogador) ===== */}
      <Modal
        open={rentOpen}
        title="Receber aluguel"
        onClose={() => {
          setRentOpen(false);
          setRentPropId('');
          setRentPaymentMethod('pix');
          setRentCashPayerUid('');
          setRentCashMsg('');
          setRentQrUrl('');
          setRentCode('');
        }}
      >
        {(() => {
          const prop = properties.find((p) => p.id === rentPropId);
          if (!prop) return <div className="empty">Propriedade não encontrada.</div>;

          const titleBase = `Aluguel • ${prop.name}`;
          return (
            <>
              <div className="sum">
                <div className="li2">
                  <span>Propriedade</span>
                  <b style={{ color: prop.colorHex }}>{prop.name}</b>
                </div>
                <div className="li2">
                  <span>Tipo</span>
                  <b>{prop.kind === 'MULTIPLIER' ? 'Multiplicador' : 'Normal'}</b>
                </div>
              </div>

              <div className="field">
                <div className="lab">Receber por</div>
                <div className="seg2">
                  <button
                    className={rentPaymentMethod === 'pix' ? 'segBtn active' : 'segBtn'}
                    type="button"
                    onClick={() => { setRentPaymentMethod('pix'); setRentCashMsg(''); setRentCashPayerUid(''); }}
                  >
                    Pix
                  </button>
                  <button
                    className={rentPaymentMethod === 'cash' ? 'segBtn active' : 'segBtn'}
                    type="button"
                    onClick={() => { setRentPaymentMethod('cash'); setRentCashMsg(''); setRentQrUrl(''); setRentCode(''); }}
                  >
                    Dinheiro
                  </button>
                </div>
              </div>

              {rentPaymentMethod === 'cash' && (
                <div className="field">
                  <div className="lab">Quem pagou em dinheiro?</div>
                  <select className="inp" value={rentCashPayerUid} onChange={(e) => setRentCashPayerUid(e.target.value)}>
                    <option value="">Selecione o jogador...</option>
                    {playersArr
                      .filter((p) => p.uid !== uid && p.uid !== BANK_UID && p.status !== 'falido' && p.status !== 'desistente')
                      .map((p) => (
                        <option key={p.uid} value={p.uid}>{p.name}</option>
                      ))}
                  </select>
                  <div className="mHint">O valor será registrado no extrato, mas não altera o saldo digital.</div>
                </div>
              )}

              {prop.kind === 'MULTIPLIER' ? (
                <>
                  <div className="field">
                    <div className="lab">Soma dos dados (ex: 2 + 5 = 7)</div>
                    <input className="inp" type="number" value={rentDiceSum} onChange={(e) => setRentDiceSum(Number(e.target.value || 0))} />
                  </div>

                  <button
                    className="btn primary"
                    onClick={() => {
                      const amt = Math.max(0, (prop.multiplierValue || 0) * Math.max(0, Number(rentDiceSum || 0)));
                      chargeRent(amt, `${titleBase} • Dados: ${rentDiceSum}`, { type: 'RENT', propId: prop.id, mode: 'MULTIPLIER', diceSum: rentDiceSum });
                    }}
                  >
                    {rentPaymentMethod === 'pix' ? 'Gerar Pix' : 'Registrar dinheiro'} (valor = {money((prop.multiplierValue || 0) * Math.max(0, Number(rentDiceSum || 0)))})
                  </button>
                </>
              ) : (
                <>
                  <div className="gridRent">
                    <button className="btn" onClick={() => chargeRent(prop.baseRent || 0, `${titleBase} • Sem casa`, { type: 'RENT', propId: prop.id, tier: 'base' })}>
                      Sem casa • {money(prop.baseRent || 0)}
                    </button>
                    <button className="btn" onClick={() => chargeRent(prop.rentByHouses?.[1] || 0, `${titleBase} • 1 casa`, { type: 'RENT', propId: prop.id, tier: '1' })}>
                      1 casa • {money(prop.rentByHouses?.[1] || 0)}
                    </button>
                    <button className="btn" onClick={() => chargeRent(prop.rentByHouses?.[2] || 0, `${titleBase} • 2 casas`, { type: 'RENT', propId: prop.id, tier: '2' })}>
                      2 casas • {money(prop.rentByHouses?.[2] || 0)}
                    </button>
                    <button className="btn" onClick={() => chargeRent(prop.rentByHouses?.[3] || 0, `${titleBase} • 3 casas`, { type: 'RENT', propId: prop.id, tier: '3' })}>
                      3 casas • {money(prop.rentByHouses?.[3] || 0)}
                    </button>
                    <button className="btn" onClick={() => chargeRent(prop.rentByHouses?.[4] || 0, `${titleBase} • 4 casas`, { type: 'RENT', propId: prop.id, tier: '4' })}>
                      4 casas • {money(prop.rentByHouses?.[4] || 0)}
                    </button>
                    <button className="btn primary" onClick={() => chargeRent(prop.hotel || 0, `${titleBase} • Hotel`, { type: 'RENT', propId: prop.id, tier: 'hotel' })}>
                      Hotel • {money(prop.hotel || 0)}
                    </button>
                  </div>
                </>
              )}

              <div className="row2">
  <button
    className="btn primary"
    onClick={() => {
      const amount =
        prop.kind === 'MULTIPLIER'
          ? (prop.multiplierValue || 0) * Math.max(0, Number(rentDiceSum || 0))
          : prop.baseRent || 0;
      chargeRent(amount, `${titleBase} • Cobrança rápida`, {
        type: 'RENT',
        propId: prop.id,
        tier: prop.kind === 'MULTIPLIER' ? 'dice' : 'base',
        diceSum: prop.kind === 'MULTIPLIER' ? rentDiceSum : undefined,
      });
    }}
  >
    {rentPaymentMethod === 'pix' ? 'Gerar cobrança Pix' : 'Registrar aluguel em dinheiro'}
  </button>

  <button
    className="btn"
    onClick={() => openTransfer(prop.id)}
  >
    Vender / Transferir ({money(prop.sellValue)})
  </button>

  <button
    className="btn"
    onClick={() => setRentOpen(false)}
  >
    Fechar
  </button>
</div>


              {rentCashMsg && <div className="mHint" style={{ marginTop: 8 }}><b>{rentCashMsg}</b></div>}

              {rentQrUrl && (
                <div className="qrBox">
                  <img className="qrImg" src={rentQrUrl} alt="QR aluguel" />
                  <div className="rowBtn">
                    <button className="btn" onClick={() => copy(rentCode)}>
                      Copiar (fallback)
                    </button>
                  </div>
                  <div className="qrCode">{rentCode}</div>
                  <div className="mHint">O outro jogador paga em “Pagar” e confirma com senha.</div>
                </div>
              )}
            </>
          );
        })()}
      </Modal>

      {/* ===== MODAL: TRANSFERÊNCIA ENTRE JOGADORES (jogador cria QR) ===== */}
      <Modal
        open={transferOpen}
        title="Vender / Transferir propriedade"
        onClose={() => {
          setTransferOpen(false);
          setTransferPropId('');
          setTransferToUid('');
          setTransferPaymentMethod('pix');
          setTransferCashMsg('');
          setTransferQrUrl('');
          setTransferCode('');
        }}
      >
        {(() => {
          const prop = properties.find((p) => p.id === transferPropId);
          if (!prop) return <div className="empty">Propriedade não encontrada.</div>;
          if (prop.ownerUid !== uid) return <div className="empty">Você não é dono desta propriedade.</div>;

          return (
            <>
              <div className="sum">
                <div className="li2">
                  <span>Propriedade</span>
                  <b style={{ color: prop.colorHex }}>{prop.name}</b>
                </div>
                <div className="li2">
                  <span>Valor fixo</span>
                  <b>{money(prop.sellValue)}</b>
                </div>
              </div>

              <div className="field">
                <div className="lab">Vender para</div>
                <select className="inp" value={transferToUid} onChange={(e) => setTransferToUid(e.target.value)}>
                  <option value="">Selecione um jogador...</option>
                  {playersArr
                    .filter((p) => p.uid !== uid && p.uid !== BANK_UID && p.status !== 'falido' && p.status !== 'desistente')
                    .map((p) => (
                      <option key={p.uid} value={p.uid}>
                        {p.name}
                      </option>
                    ))}
                </select>
              </div>

              <div className="field">
                <div className="lab">Forma de pagamento</div>
                <div className="seg2">
                  <button
                    className={transferPaymentMethod === 'pix' ? 'segBtn active' : 'segBtn'}
                    type="button"
                    onClick={() => { setTransferPaymentMethod('pix'); setTransferCashMsg(''); }}
                  >
                    Pix
                  </button>
                  <button
                    className={transferPaymentMethod === 'bank_transfer' ? 'segBtn active' : 'segBtn'}
                    type="button"
                    onClick={() => { setTransferPaymentMethod('bank_transfer'); setTransferCashMsg(''); setTransferQrUrl(''); setTransferCode(''); }}
                  >
                    Transferência
                  </button>
                  <button
                    className={transferPaymentMethod === 'cash' ? 'segBtn active' : 'segBtn'}
                    type="button"
                    onClick={() => { setTransferPaymentMethod('cash'); setTransferCashMsg(''); setTransferQrUrl(''); setTransferCode(''); }}
                  >
                    Dinheiro
                  </button>
                </div>
                <div className="mHint">
                  {transferPaymentMethod === 'cash'
                    ? 'Dinheiro físico não altera o saldo digital.'
                    : transferPaymentMethod === 'bank_transfer'
                    ? 'O comprador autoriza a transferência bancária na própria conta.'
                    : 'O comprador paga escaneando o Pix.'}
                </div>
              </div>

              {transferPaymentMethod === 'pix' ? (
                <button className="btn primary" onClick={generateTransferQr} disabled={!transferToUid}>
                  Gerar Pix para o comprador pagar
                </button>
              ) : transferPaymentMethod === 'bank_transfer' ? (
                <button className="btn primary" onClick={createBankPropertyTransferRequest} disabled={!transferToUid}>
                  Enviar transferência para o comprador
                </button>
              ) : (
                <button className="btn primary" onClick={registerCashPropertyTransfer} disabled={!transferToUid}>
                  Confirmar recebimento em dinheiro
                </button>
              )}

              {transferCashMsg && <div className="mHint" style={{ marginTop: 8 }}><b>{transferCashMsg}</b></div>}

              {transferQrUrl && (
                <div className="qrBox">
                  <img className="qrImg" src={transferQrUrl} alt="QR venda" />
                  <div className="rowBtn">
                    <button className="btn" onClick={() => copy(transferCode)}>
                      Copiar (fallback)
                    </button>
                  </div>
                  <div className="qrCode">{transferCode}</div>
                  <div className="mHint">Quando pagar, aparece popup no bancário para transferir a propriedade.</div>
                </div>
              )}
            </>
          );
        })()}
      </Modal>

      {/* ===== POPUP bancário: transferência entre jogadores paga -> transferir? ===== */}
      <Modal
        open={transferPaidPopupOpen}
        title="Transferência paga"
        onClose={() => {
          setTransferPaidPopupOpen(false);
          setPendingTransfer(null);
        }}
      >
        {!pendingTransfer ? (
          <div className="empty">Nada pendente.</div>
        ) : (
          <>
            <div className="sum">
              <div className="li2">
                <span>De</span>
                <b>{pendingTransfer.fromName}</b>
              </div>
              <div className="li2">
                <span>Para</span>
                <b>{pendingTransfer.toName}</b>
              </div>
              <div className="li2">
                <span>Propriedade</span>
                <b>{pendingTransfer.propName}</b>
              </div>
              <div className="li2">
                <span>Valor</span>
                <b>{money(pendingTransfer.amount)}</b>
              </div>
              <div className="li2">
                <span>Status</span>
                <b>Paga • Transferir?</b>
              </div>
            </div>

            <button className="btn primary" onClick={bankerConfirmPlayerTransfer}>
              Sim, transferir agora
            </button>
            <button className="btn" onClick={() => setTransferPaidPopupOpen(false)}>
              Não agora
            </button>
          </>
        )}
      </Modal>

<Modal
  open={role === 'bancario' && endGameOpen}
  title="Finalizar partida"
  onClose={() => {
    setEndGameOpen(false);
    setEndWinnerUid('');
    setEndConfirmStep(false);
    setEndErr('');
  }}
>
  {!endConfirmStep ? (
    <>
      <div className="mHint">Selecione o ganhador. Depois, você terá 9s para confirmar.</div>

      <div className="field">
        <div className="lab">Ganhador</div>
        <select className="inp" value={endWinnerUid} onChange={(e) => setEndWinnerUid(e.target.value)}>
          <option value="">Selecione um jogador...</option>
          {playersArr.map((p) => (
            <option key={p.uid} value={p.uid}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      {endErr && <div className="err">{endErr}</div>}

      <button className="btn primary" onClick={() => setEndConfirmStep(true)} disabled={!endWinnerUid}>
        Continuar
      </button>
    </>
  ) : (
    <>
      <div className="sum">
        <div className="li2">
          <span>Confirmação</span>
          <b>Tem {endCountdown}s para confirmar</b>
        </div>
        <div className="li2">
          <span>Ganhador</span>
          <b>{room.players?.[endWinnerUid]?.name || 'Jogador'}</b>
        </div>
      </div>

      {endErr && <div className="err">{endErr}</div>}

      <button className="btn primary" onClick={finalizeGameNow}>
        OK, finalizar agora
      </button>

      <button
        className="btn"
        onClick={() => {
          setEndConfirmStep(false);
          setEndWinnerUid('');
          setEndGameOpen(false);
          setEndErr('');
        }}
      >
        Cancelar
      </button>
    </>
  )}
</Modal>
<Modal
  open={gameEndedOpen}
  title="Partida encerrada"
  onClose={() => {}}
>
  {!gameEndedData ? (
    <div className="empty">Partida encerrada.</div>
  ) : (
    <>
      <div className="sum">
        <div className="li2">
          <span>Ganhador</span>
          <b>{gameEndedData.winnerName}</b>
        </div>
        <div className="li2">
          <span>Casas</span>
          <b>{gameEndedData.winnerHouses}</b>
        </div>
        <div className="li2">
          <span>Carteira</span>
          <b>{money(Number(gameEndedData.winnerBalance || 0))}</b>
        </div>
      </div>

      <div className="mHint">O bancário encerrou a partida. Aperte sair para voltar ao login.</div>

      <button className="btn primary" onClick={logout}>
        Sair
      </button>
    </>
  )}
</Modal>

      <style jsx>{`
        .wrap {
          min-height: 100vh;
          background: #eef3f1;
          font-family: system-ui;
        }

        .header {
          background: linear-gradient(160deg, #0b5d4a 0%, #08483b 55%, #052f28 100%);
          color: #fff;
          padding: 18px 18px 22px;
          border-bottom-left-radius: 22px;
          border-bottom-right-radius: 22px;
        }

        .hTop {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }

  .avatarLogo{
  width: 38px;
  height: 38px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.25);
  background: rgba(255, 255, 255, 0.14);
  display: grid;
  place-items: center;
  cursor: pointer;
  padding: 0;
  overflow: hidden;
  position: relative;
}

.avatarLogo img{
  width: 100%;
  height: 100%;
  object-fit: cover;
  display:block;
}

.avatarBL{
  position:absolute;
  inset:0;
  display:grid;
  place-items:center;
  font-weight: 1100;
  letter-spacing: .6px;
  color: #fff;
  opacity: 0; /* só aparece se falhar o favicon.ico */
  text-shadow: 0 8px 18px rgba(0,0,0,.35);
}

.avatarLogo.avatarFallback{
  background: linear-gradient(160deg, rgba(255,255,255,.25), rgba(255,255,255,.10));
}

.avatarLogo.avatarFallback .avatarBL{
  opacity: 1;
}

        .icons {
          display: flex;
          gap: 10px;
        }

        .iconBtn {
          border: 1px solid rgba(255, 255, 255, 0.25);
          background: rgba(255, 255, 255, 0.14);
          color: #fff;
          font-weight: 900;
          padding: 8px 12px;
          border-radius: 999px;
          cursor: pointer;
          font-size: 12px;
        }

        .hello {
          margin-top: 14px;
          font-size: 18px;
          font-weight: 1000;
        }

        .sub {
          margin-top: 6px;
          font-size: 12px;
          opacity: 0.9;
        }

        .gameOnly {
          margin-top: 10px;
          display: inline-flex;
          width: fit-content;
          font-size: 9px;
          font-weight: 1000;
          letter-spacing: .9px;
          padding: 5px 8px;
          border-radius: 999px;
          background: rgba(255,255,255,.12);
          border: 1px solid rgba(255,255,255,.18);
          opacity: .88;
        }

        .receipt {
          display: grid;
          gap: 12px;
          text-align: center;
        }
        .receiptOk {
          width: 58px;
          height: 58px;
          border-radius: 999px;
          display: grid;
          place-items: center;
          margin: 0 auto;
          background: #e7f7f1;
          color: #0b5d4a;
          font-size: 30px;
          font-weight: 1000;
        }
        .receiptTitle {
          font-size: 15px;
          font-weight: 1000;
          color: #17322c;
        }
        .receiptAmount {
          font-size: 28px;
          font-weight: 1100;
          color: #071f1a;
        }
        .receiptId {
          max-width: 180px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .page {
          padding: 14px 14px 22px;
          max-width: 980px;
          margin: 0 auto;
          display: grid;
          gap: 12px;
        }

        .card {
          background: #fff;
          border-radius: 20px;
          padding: 16px;
          border: 1px solid rgba(11, 93, 74, .08);
          box-shadow: 0 12px 34px rgba(6, 47, 40, 0.07);
          display: grid;
          gap: 12px;
        }

        .row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
        }
        .row2 {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
        }

        .label {
          color: #111;
          font-weight: 1000;
          font-size: 14px;
        }

        .balance {
          margin-top: 4px;
          font-weight: 1100;
          font-size: 18px;
          color: #111;
        }
        .balance.blur{filter:blur(7px);user-select:none}

        .blocked {
          margin-top: 8px;
          padding: 10px 12px;
          border-radius: 14px;
          background: rgba(239, 68, 68, 0.1);
          border: 1px solid rgba(239, 68, 68, 0.18);
          color: #7a1f1f;
          font-weight: 900;
          font-size: 12px;
        }

        .chevBtn {
          border: none;
          background: transparent;
          cursor: pointer;
          padding: 6px 10px;
          border-radius: 12px;
        }
        .chevBtn:hover {
          background: rgba(0, 0, 0, 0.06);
        }
        .chev {
          font-size: 26px;
          color: #bbb;
          line-height: 1;
        }

        .hint {
          color: #666;
          font-size: 13px;
          line-height: 1.35;
          margin-top: 4px;
        }
        .hintSmall {
          color: #666;
          font-size: 12px;
          line-height: 1.35;
        }

        .actions {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 10px;
        }

        .act {
          border: none;
          background: #f2f2f7;
          border-radius: 14px;
          padding: 12px 10px;
          cursor: pointer;
          font-weight: 900;
          color: #222;
          display: grid;
          gap: 8px;
          justify-items: center;
          font-size: 12px;
        }
        .act.disabled {
          opacity: 0.55;
          cursor: not-allowed;
        }

        .ico {
          width: 38px;
          height: 38px;
          border-radius: 999px;
          display: grid;
          place-items: center;
          background: rgba(11, 93, 74, 0.14);
          color: #08483b;
          border: 1px solid rgba(11, 93, 74, 0.16);
        }

        .adminList {
          display: grid;
          gap: 10px;
        }
        .adminRow {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
          padding: 12px;
          border-radius: 16px;
          background: #f2f2f7;
        }
        .adminName {
          font-weight: 1000;
          color: #111;
          font-size: 13px;
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .dot {
          width: 10px;
          height: 10px;
          border-radius: 999px;
          display: inline-block;
        }
        .dot.on {
          background: #22c55e;
        }
        .dot.off {
          background: #94a3b8;
        }

        .adminMeta {
          margin-top: 2px;
          color: #666;
          font-size: 12px;
        }
        .adminBtns {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
          justify-content: flex-end;
        }
        .pillBtn {
          border: none;
          background: #0b5d4a;
          color: #fff;
          font-weight: 1000;
          padding: 10px 12px;
          border-radius: 999px;
          cursor: pointer;
          font-size: 12px;
        }
        .pillBtn.ghost {
          background: rgba(11, 93, 74, 0.12);
          color: #08483b;
          border: 1px solid rgba(11, 93, 74, 0.18);
        }
        .pillBtn.danger {
          background: rgba(239, 68, 68, 0.12);
          color: #b91c1c;
          border: 1px solid rgba(239, 68, 68, 0.22);
        }

        .sectionTitle {
          margin-top: 2px;
          font-weight: 1000;
          color: #111;
          font-size: 13px;
        }
        .linkBtn {
          border: none;
          background: transparent;
          cursor: pointer;
          font-weight: 1000;
          color: #08483b;
          font-size: 12px;
          padding: 6px 10px;
          border-radius: 12px;
        }
        .linkBtn:hover {
          background: rgba(11, 93, 74, 0.08);
        }

        .propGrid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 10px;
        }
        @media (max-width: 760px) {
          .propGrid {
            grid-template-columns: 1fr;
          }
          .actions {
            grid-template-columns: repeat(2, 1fr);
          }
        }
.propViewTabs{
  display:grid;
  grid-template-columns:repeat(2,minmax(0,1fr));
  gap:8px;
  margin:12px 0 10px;
  padding:5px;
  border-radius:16px;
  background:#eef1f3;
}
.propViewBtn{
  border:0;
  border-radius:12px;
  padding:11px 10px;
  background:transparent;
  color:#46505a;
  font-weight:900;
  cursor:pointer;
}
.propViewBtn span{
  display:inline-grid;
  place-items:center;
  min-width:22px;
  height:22px;
  margin-left:4px;
  padding:0 6px;
  border-radius:999px;
  background:rgba(0,0,0,.08);
  font-size:11px;
}
.propViewBtn.active{
  background:#fff;
  color:#0b5d4a;
  box-shadow:0 4px 14px rgba(0,0,0,.08);
}
.propViewBtn.active span{background:rgba(11,93,74,.12);}

.propFilters{
  display:grid;
  grid-template-columns: 1.4fr 1fr 1fr auto;
  gap:10px;
  margin-top:10px;
}

.propSearch{
  height:44px;
  border-radius:14px;
  border:1px solid rgba(0,0,0,.10);
  background:#fff;
  padding:0 12px;
  font-weight:900;
  outline:none;
}

.propSelect{
  height:44px;
  border-radius:14px;
  border:1px solid rgba(0,0,0,.10);
  background:#fff;
  padding:0 12px;
  font-weight:900;
  outline:none;
}

.propClear{
  height:44px;
  border-radius:14px;
  border:1px solid rgba(0,0,0,.10);
  background:#f2f2f7;
  padding:0 14px;
  font-weight:1100;
  cursor:pointer;
}

@media (max-width: 760px){
  .propFilters{
    grid-template-columns: 1fr;
  }
}

.iconsCol{
  display:grid;
  gap:8px;
  justify-items:end;
}

.iconsRow{
  display:flex;
  gap:10px;
}

.dangerBtn{
  background: rgba(255, 59, 48, 0.16);
  border: 1px solid rgba(255, 59, 48, 0.28);
  color:#fff;
}


        /* ===== Cards (capa/traseira) removido: agora visualização abre em popup ===== */
.viewModalFooter{
  display:flex;
  justify-content:space-between;
  align-items:center;
  gap:12px;
  margin-top:12px;
}

.viewModalFooter .btn{
  height:46px;
  border-radius:14px;
}

.viewModalFooter .btn.primary{
  min-width:160px;
  margin-left:auto;
}

        .pMiniCard{
          position:relative;
          background:#eef0f6;
          border-radius:22px;
          overflow:hidden;
          box-shadow:0 18px 34px rgba(0,0,0,.18);
          min-height: 360px;
          display:flex;
          flex-direction:column;
        }
        .pMiniTop{
          padding:72px 18px 18px;
          font-weight:1100;
          font-size:30px;
          letter-spacing:.8px;
          text-align:center;
          color:#121212;
        }
        .pBand{
          margin-top:8px;
          padding:18px 16px;
          display:grid;
          gap:10px;
          box-shadow:0 18px 28px rgba(0,0,0,.22);
        }
        .pBandName{
          font-weight:1100;
          font-size:18px;
          letter-spacing:.3px;
          color:#fff;
          text-align:center;
        }
        .pBandRow{
          display:flex;
          justify-content:space-between;
          font-weight:1100;
          color:#fff;
        }
        .pOwner.center{justify-content:center;text-align:center}
        .pOwner{
          margin-top:auto;
          display:flex;
          gap:10px;
          align-items:center;
          padding:14px 16px 10px;
          font-weight:1000;
          color:#1b1b1b;
        }
        .pOwner .key{filter:grayscale(1);opacity:.85}
        .pBtnsOut{
  width:100%;
  display:flex;
  gap:12px;
  justify-content:center;
  padding:12px 14px 0;
}
.pBtn{
  height:46px;
  min-width:140px;
  max-width:180px;
  width:45%;
  border:0;
  border-radius:999px;
  background:#7a2cff;
  color:#fff;
  font-weight:1100;
  cursor:pointer;
  box-shadow:0 12px 18px rgba(0,0,0,.18);
  letter-spacing:.3px;
}
.pBtn.ghost{
  background:rgba(138,5,190,.12);
  color:#08483b;
  border:1px solid rgba(138,5,190,.22);
  box-shadow:none;
}
        .pBtns{
          display:grid;
          grid-template-columns:1fr 1fr;
          gap:12px;
          padding:0 16px 16px;
        }
        .pBtn{
          height:46px;
          border:0;
          border-radius:999px;
          background:#7a2cff;
          color:#fff;
          font-weight:1100;
          cursor:pointer;
          box-shadow:0 12px 18px rgba(0,0,0,.18);
          letter-spacing:.3px;
        }
        .pBtn:active{transform:scale(.99)}
        .pBtn.disabled{opacity:.55;cursor:not-allowed}
        
/* ribbon topo (verde/vermelho) */
.ribbon{
  position:absolute;
  left:16px;
  right:16px;
  top:12px;
  height:44px;
  border-radius:999px;
  display:flex;
  align-items:center;
  justify-content:center;
  padding:0 14px;
  font-weight:1100;
  color:#fff;
  box-shadow:0 14px 22px rgba(0,0,0,.22);
  z-index:2;
}

.ribbon.ok{background:linear-gradient(180deg,#1fd15a 0%, #0fae44 100%)}
.ribbon.bad{background:linear-gradient(180deg,#ff3b30 0%, #d60f07 100%)}

.ribbonText{
  font-size:14px;
  letter-spacing:.3px;
  line-height:1;
  white-space:nowrap;
  overflow:hidden;
  text-overflow:ellipsis;
}
        /* verso */
        .pBackCard{
          position:relative;
          background:#eef0f6;
          border-radius:22px;
          overflow:hidden;
          box-shadow:0 18px 34px rgba(0,0,0,.18);
          min-height:360px;
          display:flex;
          flex-direction:column;
        }
        .pBackTop{
          padding:16px 16px 14px;
          color:#111;
          font-weight:1100;
          background:#f0a22e;
        }
        .pBackName{font-size:22px;letter-spacing:.4px}
        .pBackBody{
          padding:12px 16px 6px;
          display:grid;
          gap:8px;
        }
        .rentLine{
  display:flex;
  justify-content:space-between;
  gap:12px;
  line-height:1.1;
  background:#ffffff;
  border:1px solid rgba(0,0,0,.15);
  border-radius:14px;
  padding:10px 12px;
}

        .rentLine .k{
  font-size:12px;
  font-weight:700;
  color:#111;
  opacity:1;
}

.rentLine .v{
  font-size:13px;
  font-weight:900;
  color:#000;
}

        .pBackOwner{
          margin-top:8px;
          padding:10px 12px;
          border-radius:14px;
          background:rgba(0,0,0,.05);
          font-weight:1000;
        }


        .prop{background:#f4f4f7;border-radius:18px;border:1px solid rgba(0,0,0,.06);overflow:hidden}
        .propBtn {
          cursor: pointer;
          text-align: left;
        }
        .propBtn:hover {
          box-shadow: 0 14px 34px rgba(0, 0, 0, 0.08);
        }
        .pTop{padding:10px 12px 8px;display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
        .pNameRow {
          display: flex;
          align-items: center;
          gap: 10px;
          min-width: 0;
        }
        .colorBlock{display:none}
        .pColorBar{height:10px;width:100%}
        .pName {
          font-weight: 1000;
          font-size: 13px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .tag {
          padding: 6px 10px;
          border-radius: 999px;
          background: rgba(0, 0, 0, 0.04);
          border: 2px solid transparent;
          font-weight: 1000;
          font-size: 11px;
          white-space: nowrap;
        }
        .pLine {
          display: flex;
          justify-content: space-between;
          gap: 10px;
          font-size: 12px;
          color: #444;
        }

        .ledger {
          display: grid;
          gap: 10px;
        }
        .lRow {
          display: flex;
          justify-content: space-between;
          gap: 12px;
          padding: 12px;
          border-radius: 16px;
          background: #f2f2f7;
        }
        .lTitle {
          font-weight: 1000;
          color: #111;
          font-size: 13px;
        }
        .lSub {
          margin-top: 2px;
          color: #666;
          font-size: 12px;
        }
        .lAmt {
          font-weight: 1000;
          font-size: 13px;
          white-space: nowrap;
        }
        .pos {
          color: #1f7a3b;
        }
        .neg {
          color: #a12828;
        }

        .btn {
          border: 1px solid rgba(0, 0, 0, 0.08);
          background: #fff;
          padding: 12px 14px;
          border-radius: 14px;
          font-weight: 1000;
          cursor: pointer;
          color: #222;
        }
        .btn.primary {
          background: #0b5d4a;
          color: #fff;
          border: none;
        }

        .field {
          display: grid;
          gap: 6px;
        }
        .lab {
          font-size: 12px;
          color: #666;
          font-weight: 900;
        }
        .inp,
        .ta,
        select.inp {
          padding: 12px 14px;
          border-radius: 14px;
          border: 1px solid #e5e5e5;
          outline: none;
          background: #fff;
          color: #111;
          font-weight: 700;
        }
        .ta {
          resize: vertical;
        }

        .err {
          background: rgba(255, 0, 0, 0.06);
          border: 1px solid rgba(255, 0, 0, 0.12);
          color: #7a1f1f;
          padding: 10px 12px;
          border-radius: 14px;
          font-size: 13px;
        }

        .mHint {
          color: #666;
          font-size: 13px;
          line-height: 1.35;
        }

        .sum {
          display: grid;
          gap: 8px;
          padding: 12px;
          border-radius: 16px;
          background: #f2f2f7;
        }
        .li2 {
          display: flex;
          justify-content: space-between;
          gap: 10px;
          font-size: 13px;
          color: #333;
        }

        .empty {
          color: #666;
          font-size: 13px;
        }

        .qrBox {
          display: grid;
          gap: 10px;
          justify-items: center;
          padding: 12px;
          border-radius: 16px;
          background: #f2f2f7;
          width: 100%;
          max-width: 100%;
          box-sizing: border-box;
          overflow: visible;
        }
.qrImg {
  width: min(250px, 68vw);
  height: auto;
  aspect-ratio: 1 / 1;
  object-fit: contain;
  box-sizing: border-box;
  border-radius: 14px;
  background: #fff;
  border: 1px solid rgba(0, 0, 0, 0.08);
  padding: 12px;
  display: block;
  max-width: 100%;
  max-height: min(250px, 42vh);
  flex: 0 0 auto;
}
        .rowBtn {
          display: flex;
          gap: 8px;
        }

        .seg2 {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(105px, 1fr));
          gap: 8px;
        }
        .segBtn {
          padding: 12px 12px;
          border-radius: 14px;
          border: 1px solid #e5e5e5;
          cursor: pointer;
          background: #fff;
          font-weight: 1000;
          color: #444;
        }
        .segBtn.active {
          background: #0b5d4a;
          color: #fff;
          border-color: #0b5d4a;
        }

        .gridRent {
          display: grid;
          grid-template-columns: 1fr;
          gap: 8px;
        }
      /* ===== VENDER PROPRIEDADE: SEM ROLAGEM E CABENDO NO POPUP ===== */
.sellFit{
  display: grid;
  gap: 10px;
  max-height: none;
  overflow: visible;
}

/* QR menor pra não estourar */
.sellFit .qrImg{
  width: min(220px, 62vw);
  height: auto;
}

/* código do pix menor e sem scroll */
.sellFit .pixCode{
  max-height: 56px;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  word-break: break-all;
}

.housesCard{
  background:#eef0f6;
  border:1px solid rgba(0,0,0,.08);
  border-radius:16px;
  padding:10px 12px;
}

.housesTitle{
  font-weight:1100;
  font-size:12px;
  color:#222;
  margin-bottom:8px;
}

/* AQUI É A CAIXA BRANCA QUE AGORA CONTÉM TUDO */
.housesMoneyBox{
  border-radius:14px;
  border:1px solid rgba(0,0,0,.18);
  background:#ffffff;
  padding:12px;
}

.housesGrid{
  display:grid;
  grid-template-columns: 1fr 140px;
  gap:12px;
  align-items:center;
}

.housesColL, .housesColR{
  display:grid;
  gap:8px;
}

.houseLine{
  font-weight:800;
  font-size:12px;
  color:#111;
}

.moneyRow{
  font-weight:900;
  font-size:13px;
  color:#000;
  text-align:right;
}

.balRow{
  display:flex;
  align-items:center;
  gap:10px;
}

.eyeBtn{
  width:36px;
  height:36px;
  border-radius:12px;
  border:1px solid rgba(0, 0, 0, 0);
  background:#fff;
  cursor:pointer;
  display:grid;
  place-items:center;
  font-size:16px;
}

.eyeBtn:active{transform:scale(.98)}

.modalContent{
  width: min(720px, 92vw);
  max-height: 85vh;
  overflow: hidden;           /* IMPORTANTÍSSIMO: mata a rolagem do popup */
  display: flex;
  flex-direction: column;
}

.modalBody{
  flex: 1;
  overflow: hidden;           /* não deixa virar “página” dentro */
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.qrWrap{
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 8px 0;
}

.pixCode{
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  font-size: 12px;
  line-height: 1.25;
  background: #f4f4f6;
  border-radius: 10px;
  padding: 10px;
  user-select: text;

  max-height: 84px;
  overflow: hidden;
  word-break: break-all;

  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
}
.rowBtn{
  display:flex;
  gap:8px;
  flex-wrap: wrap;
  justify-content: center;
}
/* ===== VENDER PROPRIEDADE: layout sem “buraco” ===== */
.sellFit{
  display: grid;
  gap: 10px;
  align-content: start;      /* não estica vertical */
  grid-auto-rows: min-content;
  overflow: visible;
  max-height: none;
}

/* qrBox não pode virar um “retângulo grande” */
.sellFit .qrBox{
  padding: 10px;
  gap: 8px;
  justify-items: center;
  align-content: start;      /* <- isso resolve o “vazio” */
}

/* QR um pouco menor só pra garantir encaixe */
.sellFit .qrImg{
  width: min(220px, 62vw);
  height: auto;
}
  

/* ===== VENDER: QR compacto (não corta) ===== */
.sellQrBox{
  padding: 10px;
  gap: 10px;
}

.sellQrImg{
  width: min(220px, 62vw);
  height: auto;
  padding: 10px;
}

/* linha de copiar */
.copyRow{
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: 520px;
}

.copyIconBtn{
  width: 42px;
  height: 42px;
  border-radius: 14px;
  border: 1px solid rgba(0,0,0,.10);
  background: #fff;
  cursor: pointer;
  display: grid;
  place-items: center;
  flex: 0 0 auto;
}

.copyIconBtn:active{ transform: scale(.98); }

/* input com código inteiro, mas visualmente “abc...xyz” */
.pixInput{
  height: 42px;
  flex: 1;
  border-radius: 14px;
  border: 1px solid rgba(0,0,0,.10);
  background: #fff;
  padding: 0 12px;
  font-weight: 900;
  font-size: 12px;
  color: #111;

  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis; /* <- aqui fica com “...” */
}

        .bankPayMenu{margin-top:12px;background:rgba(255,255,255,.10);border:1px solid rgba(255,255,255,.18);border-radius:18px;padding:12px;}
        .bankPayTitle{font-weight:1000;margin-bottom:10px}
        .bankPayGrid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}
        .bankPayCard{border:0;border-radius:16px;padding:12px;text-align:left;background:rgba(255,255,255,.92);color:#111;box-shadow:0 10px 24px rgba(0,0,0,.20);cursor:pointer}
        .bankPayCard:active{transform:scale(.99)}
        .bpt{font-weight:1000}
        .bps{font-size:12px;opacity:.7;margin-top:2px}
        .bankPayHint{margin-top:10px;font-size:12px;opacity:.85}
        .camWrap{display:grid;gap:10px}
        .camFrame{position:relative;overflow:hidden;border-radius:18px;background:#0b0b0b;aspect-ratio:1/1;isolation:isolate}
        .camVideo{width:100%;height:100%;object-fit:cover;display:block;background:#0b0b0b;transform:translateZ(0)}
        .camLine{position:absolute;left:10%;right:10%;top:50%;height:2px;background:rgba(122,44,255,.9);box-shadow:0 0 18px rgba(122,44,255,.9)}
        .pHouses{margin-top:10px;padding-top:10px;border-top:1px dashed rgba(255,255,255,.22)}
        .pHouseTitle{font-weight:1000;font-size:12px;margin-top:6px;opacity:.9}
        .pHouseGrid{display:grid;grid-template-columns:1fr;gap:4px;margin-top:6px}
        .pHouseItem{display:flex;align-items:baseline;justify-content:space-between;gap:10px;padding:0;margin:0;font-size:12px;line-height:1.1}
        .pHouseItem span{opacity:.85;font-weight:900}
        .pHouseItem b{font-size:13px}

        .pendBox{margin-top:14px;padding-top:10px;border-top:1px solid rgba(0,0,0,.08)}
        .pendTitle{font-weight:1000;margin-bottom:4px}
        .pendHint{font-size:12px;opacity:.75;margin-bottom:10px}
        .pendList{display:grid;gap:10px}
        .pendItem{border:1px solid rgba(0,0,0,.10);border-radius:14px;padding:10px;background:#fff}
        .pendRow{display:flex;align-items:center;justify-content:space-between;gap:10px}
        .pendMain{min-width:0}
        .pendName{font-weight:1000;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .pendSub{font-size:12px;opacity:.8}
        .miniBtn{height:34px;border-radius:12px;border:0;background:#7a2cff;color:#fff;font-weight:1000;padding:0 12px;cursor:pointer;white-space:nowrap}
        .pendBar{height:8px;border-radius:999px;background:rgba(0,0,0,.08);overflow:hidden;margin-top:8px}
        .pendBarFill{height:100%;background:#7a2cff}
        .pendNext{margin-top:6px;font-size:12px;opacity:.85}
        .pendNext.ok{opacity:1;font-weight:900}
        .instPreview{margin-top:8px;font-size:13px;opacity:.85}
        .pendDots{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}
        .pendDot{width:26px;height:26px;border-radius:999px;display:grid;place-items:center;font-weight:1000;font-size:12px;border:1px solid rgba(0,0,0,.12);opacity:.75}
        .pendDot.on{opacity:1;border-color:rgba(52,199,89,.45)}
        .pendDot.next{box-shadow:0 0 0 3px rgba(122,44,255,.18);opacity:1}
      
/* ===== NOTIFICAÇÕES (Modal) ===== */
.notiList{
  display: grid;
  gap: 10px;
}

.notifItem{
  background: #ffffff;
  border: 1px solid rgba(0,0,0,.10);
  border-radius: 14px;
  padding: 10px 12px;
  color: #111; /* <- garante que não herda branco */
}

.notifItem.ok{
  border-color: rgba(34,197,94,.35);
}

.notifItem.warn{
  border-color: rgba(239,68,68,.30);
}

.notifTitle{
  font-weight: 1000;
  color: #000; /* <- TÍTULO PRETO */
}

.muted{
  color: #111; /* <- TEXTO PRETO (detail + data + “Sem notificações.”) */
  opacity: .85;
  font-weight: 800;
}


`}</style>

  <Modal open={notifOpen} title="Notificações" onClose={() => setNotifOpen(false)}>
    <div className="notiList">
      {!notifs.length && <div className="muted">Sem notificações.</div>}
      {notifs.map((n) => (
        <div
          key={n.id}
          className={
            "notifItem " + (n.kind === "success" ? "ok" : n.kind === "warning" ? "warn" : "")
          }
        >
          <div className="notifTitle">{n.title}</div>
          {!!n.detail && <div className="muted">{n.detail}</div>}
          <div className="muted">{new Date(n.at).toLocaleString()}</div>
        </div>
      ))}
    </div>
  </Modal>

      {/* ===== MODAL: VISUALIZAR PROPRIEDADE ===== */}
      <Modal
        open={viewPropOpen}
        title=""
        onClose={() => {
          setViewPropOpen(false);
          setViewProp(null);
        }}
      >
        {!viewProp ? (
          <div className="empty">Propriedade não encontrada.</div>
        ) : (
          <div className="viewModalBody">
            <div className="pBackCard">
              <div className="pBackTop" style={{ background: viewProp.colorHex || "#f0a22e" }}>
                <div className="pBackName">{viewProp.name}</div>
              </div>

              <div className="pBackBody">
                <div className="rentLine">
                  <span className="k">Hipoteca</span>
                  <span className="v">{money(viewProp.price || 0)}</span>
                </div>

                {viewProp.kind === "MULTIPLIER" ? (
                  <div className="rentLine">
                    <span className="k">Cobrança</span>
                    <span className="v">
                      {money(viewProp.multiplierValue || 0)} x soma dos dados
                    </span>
                  </div>
                ) : (
                  <>
                    <div className="rentLine">
                      <span className="k">Aluguel (sem casa)</span>
                      <span className="v">{money(viewProp.baseRent || 0)}</span>
                    </div>

                    <div className="rentLine">
                      <span className="k">Hotel</span>
                      <span className="v">{money(viewProp.hotel || 0)}</span>
                    </div>

                    <div className="housesCard">
                      <div className="housesTitle">Aluguel com casas</div>

                      <div className="housesMoneyBox" aria-label="Aluguel com casas (linhas e valores)">
                        <div className="housesGrid">
                          <div className="housesColL">
                            <div className="houseLine">1 casa</div>
                            <div className="houseLine">2 casas</div>
                            <div className="houseLine">3 casas</div>
                            <div className="houseLine">4 casas</div>
                          </div>

                          <div className="housesColR">
                            <div className="moneyRow">{money(viewProp.rentByHouses?.[1] || 0)}</div>
                            <div className="moneyRow">{money(viewProp.rentByHouses?.[2] || 0)}</div>
                            <div className="moneyRow">{money(viewProp.rentByHouses?.[3] || 0)}</div>
                            <div className="moneyRow">{money(viewProp.rentByHouses?.[4] || 0)}</div>
                          </div>
                        </div>
                      </div>

                      <div className="rentLine" style={{ marginTop: 10 }}>
                        <span className="k">Venda (fixo)</span>
                        <span className="v">{money(viewProp.sellValue || 0)}</span>
                      </div>
                    </div>

                    <div className="pBackOwner">
                      <b>Proprietário:</b>{" "}
                      {viewProp.ownerUid === BANK_UID
                        ? BANK_NAME
                        : room.players?.[viewProp.ownerUid]?.name || "Jogador"}
                    </div>

                    <div className="viewModalFooter">
                      <button
                        className="btn"
                        type="button"
                        onClick={() => {
                          setViewPropOpen(false);
                          setViewProp(null);
                        }}
                      >
                        Fechar
                      </button>

                      {role === "bancario" ? (
                        <button
                          className={"btn primary" + (viewProp.ownerUid !== BANK_UID ? " disabled" : "")}
                          type="button"
                          disabled={viewProp.ownerUid !== BANK_UID}
                          onClick={() => {
                            if (viewProp.ownerUid !== BANK_UID) return;
                            setViewPropOpen(false);
                            openSell(viewProp.id);
                          }}
                        >
                          {viewProp.ownerUid !== BANK_UID ? "Já vendida" : "Vender"}
                        </button>
                      ) : (
                        <button className="btn primary" type="button" onClick={() => openRent(viewProp.id)}>
                          Cobrar aluguel
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        )}
      </Modal>

    </main>
  );
}
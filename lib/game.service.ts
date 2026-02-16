"use client";

import {
  ref,
  get,
  set,
  update,
  onValue,
  onDisconnect,
} from "firebase/database";
import { db } from "@/lib/firebase";
import { INITIAL_PROPERTIES } from "@/lib/properties";

export type Role = "jogador" | "bancario";

function normalizeRoomCode(code?: string) {
  return (code || "").trim().toUpperCase().replace(/\s+/g, "");
}

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 6; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

/* ================= SALAS ================= */

export async function listActiveRoomsByBankerName(bankerName: string) {
  const snap = await get(ref(db, "rooms"));
  if (!snap.exists()) return [];

  const rooms = snap.val();
  return Object.entries(rooms)
    .filter(
      ([_, r]: any) =>
        r.status === "active" &&
        r.bankerName?.trim() === bankerName.trim()
    )
    .map(([code, r]: any) => ({
      gameId: code,
      code,
      bankerName: r.bankerName,
    }));
}

export async function finishRoom(roomCode: string) {
  const code = normalizeRoomCode(roomCode);
  await update(ref(db, `rooms/${code}`), {
    status: "finished",
    finishedAt: Date.now(),
  });
}

/* ================= JOIN / CREATE ================= */

export async function joinOrCreateGame(params: {
  uid: string;
  name: string;
  role: Role;
  mode: "login" | "cadastro";
  roomCode?: string;
}): Promise<{ roomCode: string }> {
  const { uid, name, role, mode } = params;
  const cleanName = name.trim();

  // 🔒 Bancário só pode criar UMA sala ativa
  if (role === "bancario" && mode === "cadastro") {
    const active = await listActiveRoomsByBankerName(cleanName);
    if (active.length > 0) {
      throw new Error("Você possui salas ativas.");
    }
  }

  /* ===== CRIAR SALA ===== */
  if (role === "bancario" && mode === "cadastro") {
    let roomCode = generateRoomCode();

    while ((await get(ref(db, `rooms/${roomCode}`))).exists()) {
      roomCode = generateRoomCode();
    }

    const props: Record<string, any> = {};
    INITIAL_PROPERTIES.forEach((p) => (props[p.id] = p));

    await set(ref(db, `rooms/${roomCode}`), {
      status: "active",
      createdAt: Date.now(),
      bankerUid: uid,
      bankerName: cleanName,
      proLabore: 200000,
      bail: 50000,
      properties: props,
      players: {},
    });

    await createOrUpdatePlayer(roomCode, uid, cleanName, role);
    return { roomCode };
  }

  /* ===== ENTRAR EM SALA ===== */
  const roomCode = normalizeRoomCode(params.roomCode);
  if (!roomCode) throw new Error("Informe o código da sala.");

  const roomRef = ref(db, `rooms/${roomCode}`);
  const snap = await get(roomRef);

  if (!snap.exists() || snap.val().status !== "active") {
    throw new Error("Sala não encontrada ou finalizada.");
  }

  // Bancário login só entra se for o mesmo UID
  if (role === "bancario" && snap.val().bankerUid !== uid) {
    throw new Error("Você não é o bancário desta sala.");
  }

  await createOrUpdatePlayer(roomCode, uid, cleanName, role);
  return { roomCode };
}

/* ================= PLAYERS ================= */

async function createOrUpdatePlayer(
  roomCode: string,
  uid: string,
  name: string,
  role: Role
) {
  const playerRef = ref(db, `rooms/${roomCode}/players/${uid}`);

 await update(playerRef, {
  uid,
  name,
  role,
  online: true,
  lastSeen: Date.now(),
  createdAt: Date.now(),
});

  onDisconnect(playerRef).update({
    online: false,
    lastSeen: Date.now(),
  });
}

/* ================= LISTENERS (HOME) ================= */

export function listenPlayers(roomCode: string, cb: (players: any[]) => void) {
  return onValue(ref(db, `rooms/${roomCode}/players`), (snap) => {
    const v = snap.val() || {};
    cb(Object.values(v));
  });
}

export function listenProperties(
  roomCode: string,
  cb: (props: any[]) => void
) {
  return onValue(ref(db, `rooms/${roomCode}/properties`), (snap) => {
    const v = snap.val() || {};
    cb(Object.values(v));
  });
}

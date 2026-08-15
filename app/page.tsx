"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
} from "firebase/auth";
import { auth } from "@/lib/firebase";
import {
  finishRoom,
  joinOrCreateGame,
  listActiveRoomsByBankerName,
  Role,
} from "@/lib/game.service";

/* ================= UTIL ================= */

function toEmail(name: string) {
  const safe = name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ".")
    .replace(/[^a-z0-9._-]/g, "");
  return `${safe || "jogador"}@bancoimobiliario.app`;
}

function humanError(err: any) {
  const code = String(err?.code || "");
  const msg = String(err?.message || "");

  if (code.includes("auth/invalid-credential"))
    return "Senha incorreta ou usuário não encontrado.";
  if (code.includes("auth/email-already-in-use"))
    return "Esse nome já está cadastrado. Use LOGIN.";
  if (code.includes("auth/weak-password"))
    return "Senha fraca. Use pelo menos 6 caracteres.";
  if (code.includes("auth/network-request-failed"))
    return "Sem conexão. Verifique sua internet.";

  if (msg.includes("Sala não encontrada"))
    return "Sala não encontrada. Confira o código.";
  if (msg.includes("Você não é o bancário"))
    return "Você não é o bancário desta sala.";
if (msg.includes("Você possui salas ativas"))
  return "Você possui salas ativas. Use 'Esqueci a senha' para encerrar a sala anterior.";
  return "Erro no sistema. Tente novamente.";
}

/* ================= MODAL (PORTAL REAL) ================= */

function Modal({
  open,
  title,
  children,
  onClose,
}: {
  open: boolean;
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    return () => setMounted(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open || !mounted) return null;

  return createPortal(
    <>
      <div className="modalOverlay" onClick={onClose} role="presentation">
        <div
          className="modalCard"
          role="dialog"
          aria-modal="true"
          aria-label={title}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="modalHeader">
            <h3 className="modalTitle">{title}</h3>
            <button className="iconClose" onClick={onClose} aria-label="Fechar">
              ✕
            </button>
          </div>

          <div className="modalBody">{children}</div>
        </div>
      </div>

      <style jsx>{`
        .modalOverlay {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.45);
          display: grid;
          place-items: center;
          z-index: 99999;
          padding: 18px;
        }

        .modalCard {
          width: min(420px, 100%);
          background: #fff;
          border-radius: 22px;
          padding: 18px;
          color: #111;
          display: grid;
          gap: 12px;
          box-shadow: 0 18px 60px rgba(0, 0, 0, 0.35);
        }

        .modalHeader {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }

        .modalTitle {
          margin: 0;
          font-size: 16px;
          font-weight: 800;
        }

        .iconClose {
          border: none;
          background: transparent;
          cursor: pointer;
          font-size: 18px;
          line-height: 1;
          padding: 8px;
          border-radius: 10px;
        }

        .iconClose:hover {
          background: rgba(0, 0, 0, 0.06);
        }

        .modalBody {
          display: grid;
          gap: 10px;
        }
      `}</style>
    </>,
    document.body
  );
}

/* ================= PAGE ================= */

export default function Page() {
  const router = useRouter();

  const [mode, setMode] = useState<"cadastro" | "login">("cadastro");
  const [role, setRole] = useState<Role>("jogador");

  const [name, setName] = useState("");
  const [pass, setPass] = useState("");
  const [roomCode, setRoomCode] = useState("");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  /* esqueci senha */
  const [forgotOpen, setForgotOpen] = useState(false);
  const [oldUser, setOldUser] = useState("");
  const [rooms, setRooms] = useState<{ gameId: string; code: string }[]>([]);
    const [noRooms, setNoRooms] = useState(false);


  const email = useMemo(() => toEmail(name), [name]);

  const needsRoom =
    role === "jogador" || (role === "bancario" && mode === "login");

  // ✅ se já tem sessão salva, manda direto
  useEffect(() => {
    const uid = localStorage.getItem("uid");
    const rc = localStorage.getItem("roomCode");
    if (uid && rc) router.push("/home");
  }, [router]);

  async function handleEnter() {
    setError("");

    if (!name.trim()) return setError("Digite seu nome.");
    if (pass.length < 6) return setError("Senha mínima de 6 caracteres.");
    if (needsRoom && !roomCode.trim())
      return setError("Informe o código da sala.");

    setLoading(true);
    try {
      let cred;

      if (mode === "cadastro") {
        try {
          cred = await createUserWithEmailAndPassword(auth, email, pass);
        } catch (e: any) {
          if (String(e.code).includes("email-already-in-use")) {
            cred = await signInWithEmailAndPassword(auth, email, pass);
          } else {
            throw e;
          }
        }
      } else {
        cred = await signInWithEmailAndPassword(auth, email, pass);
      }

      const res = await joinOrCreateGame({
        uid: cred.user.uid,
        name: name.trim(),
        role,
        mode,
        roomCode: needsRoom ? roomCode : undefined,
      });

      if (!res?.roomCode) throw new Error("Sala não encontrada");

      // ✅ ESSENCIAL pro /home
      localStorage.setItem("uid", cred.user.uid);
      localStorage.setItem("name", name.trim());
      localStorage.setItem("email", email);
      localStorage.setItem("roomCode", res.roomCode);
      localStorage.setItem("role", role);

      router.push("/home");
    } catch (e: any) {
      setError(humanError(e));
      setLoading(false);
    }
  }

    async function searchRooms() {
    setError("");
    setNoRooms(false);
    setRooms([]);

    if (!oldUser.trim())
      return setError("Informe o usuário antigo do bancário.");

    try {
      const list = await listActiveRoomsByBankerName(oldUser.trim());

      if (!list || list.length === 0) {
        setNoRooms(true);
        return;
      }

      setRooms(list.map((r) => ({ gameId: r.gameId, code: r.code })));
    } catch {
      setError("Erro ao buscar salas.");
    }
  }

  async function finish(gameId: string) {
    try {
      await finishRoom(gameId);
      setForgotOpen(false);
      setRooms([]);
      setOldUser("");
      setError(
        "Sala encerrada. Agora cadastre novamente o bancário e crie nova sala."
      );
    } catch {
      setError("Erro ao encerrar a sala.");
    }
  }
  function goCreateNewRoom() {
    setForgotOpen(false);
    setRooms([]);
    setOldUser("");
    setNoRooms(false);
    setError("");

    // leva pro fluxo de criação de sala
    setMode("cadastro");
    setRole("bancario");
    setRoomCode(""); // bancário criando sala não precisa de código
  }


  return (
    <main className="wrap">
      {/* ✅ LOADING: logo no meio + texto + anel rodando */}
      {loading && (
        <div className="loadingOverlay" aria-label="Carregando">
          <div className="loadingCard">
            <div className="spinnerRing">
              <div className="logo">BI</div>
            </div>
            <div className="loadingText">Carregando...</div>
          </div>
        </div>
      )}

      <Modal
        open={forgotOpen}
        title="Esqueci a senha (somente bancário)"
        onClose={() => setForgotOpen(false)}
      >
        <p className="hint">
          Use para encerrar uma sala anterior e liberar novo cadastro.
        </p>

        <input
          className="modalInput"
          placeholder="Usuário antigo"
          value={oldUser}
          onChange={(e) => setOldUser(e.target.value)}
        />

        <button className="primary" onClick={searchRooms}>
          Buscar salas
        </button>

        {rooms.length > 0 && (
          <div className="roomList">
            {rooms.map((r) => (
              <div key={r.gameId} className="roomRow">
                <span className="roomCode">{r.code}</span>
                <button className="danger" onClick={() => finish(r.gameId)}>
                  Encerrar
                </button>
              </div>
            ))}
          </div>
        )}
        {noRooms && (
          <div className="noRoomsBox">
            <p className="noRoomsText">
              Usuário não possui nenhuma sala aberta em seu nome. Deseja criar uma agora?
            </p>
            <div style={{ display: "flex", justifyContent: "center" }}>
      <button className="primary" onClick={goCreateNewRoom}>
        Criar sala
      </button>
    </div>
  </div>
)}
      </Modal>

      <section className="panel">
        <div className="brandMark" aria-hidden="true">
          <span className="brandMonogram">BI</span>
          <span className="brandPulse" />
        </div>
        <div className="eyebrow">BANCO DA PARTIDA</div>
        <h1>Banco Imobiliário Pay</h1>
        <p className="gameTag">Sua conta digital da partida • sem dinheiro real</p>

        <div className="seg">
          <button
            type="button"
            className={mode === "cadastro" ? "active" : ""}
            onClick={() => setMode("cadastro")}
          >
            Cadastro
          </button>
          <button
            type="button"
            className={mode === "login" ? "active" : ""}
            onClick={() => setMode("login")}
          >
            Login
          </button>
        </div>

        <input
          placeholder="Nome"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        <input
          type="password"
          placeholder="Senha"
          value={pass}
          onChange={(e) => setPass(e.target.value)}
        />

        <div className="roles">
          <button
            type="button"
            className={role === "jogador" ? "active" : ""}
            onClick={() => setRole("jogador")}
          >
            Jogador
          </button>
          <button
            type="button"
            className={role === "bancario" ? "active" : ""}
            onClick={() => setRole("bancario")}
          >
            Bancário
          </button>
        </div>

        {needsRoom && (
          <input
            placeholder="Código da sala"
            value={roomCode}
            onChange={(e) => setRoomCode(e.target.value.toUpperCase())}
          />
        )}

        <button className="primary" onClick={handleEnter} disabled={loading}>
          {loading
            ? "Aguarde..."
            : mode === "cadastro"
            ? role === "bancario"
              ? "Criar sala"
              : "Cadastrar"
            : "Entrar"}
        </button>

        <button
          type="button"
          className="forgot"
          onClick={() => setForgotOpen(true)}
        >
          Esqueci a senha (somente bancário)
        </button>

        {error && <div className="error">{error}</div>}
      </section>

      <style jsx>{`
        .wrap {
          min-height: 100dvh;
          display: grid;
          place-items: center;
          position: relative;
          overflow: hidden;
          background:
            radial-gradient(circle at 15% 10%, rgba(61,132,255,.42), transparent 34%),
            radial-gradient(circle at 88% 85%, rgba(0,70,190,.42), transparent 32%),
            linear-gradient(145deg, #04142f 0%, #082a61 48%, #0a5cff 140%);
          font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", Inter, system-ui, sans-serif;
          padding: 24px;
        }
        .wrap:before {
          content: ""; position: fixed; width: 420px; height: 420px; border-radius: 50%;
          top: -210px; right: -120px; border: 1px solid rgba(255,255,255,.12);
          box-shadow: 0 0 0 70px rgba(255,255,255,.025), 0 0 0 140px rgba(255,255,255,.018);
          pointer-events: none;
        }
        .panel {
          width: min(430px, 100%);
          padding: 30px;
          border-radius: 28px;
          background: rgba(255,255,255,.96);
          border: 1px solid rgba(255,255,255,.72);
          color: #0b1220;
          display: grid; gap: 14px;
          box-shadow: 0 32px 90px rgba(0,17,56,.42);
          backdrop-filter: blur(24px) saturate(150%);
        }
        h1 { margin: 2px 0 0; font-size: 28px; text-align:center; font-weight: 800; letter-spacing:-.8px; color:#071b3a; }
        .gameTag { margin: 0 0 10px; text-align:center; color:#718096; font-size:12px; font-weight:650; }
        input, .modalInput {
          height: 52px; padding: 0 16px; border-radius: 15px; border:1px solid #dfe6f0; outline:none;
          font-size:15px; background:#f8faff; color:#0b1220; transition:.18s ease;
        }
        input:focus, .modalInput:focus { border-color:#0a5cff; background:#fff; box-shadow:0 0 0 4px rgba(10,92,255,.10); }
        input::placeholder { color:#98a2b3; }
        .seg,.roles { display:grid; grid-template-columns:1fr 1fr; gap:5px; padding:5px; border-radius:16px; background:#edf2f9; }
        .seg button,.roles button { height:42px; border-radius:12px; border:0; cursor:pointer; background:transparent; color:#667085; font-weight:750; transition:.18s ease; }
        .seg button:hover,.roles button:hover { color:#0a5cff; }
        .active { background:#fff !important; color:#0a5cff !important; box-shadow:0 4px 14px rgba(28,66,130,.10) !important; }
        .primary {
          min-height:50px; background:linear-gradient(180deg,#1668ff,#0754e8); color:#fff; padding:0 18px;
          border-radius:15px; border:0; font-weight:800; cursor:pointer; box-shadow:0 12px 24px rgba(10,92,255,.24);
          transition: transform .16s ease, box-shadow .16s ease;
        }
        .primary:hover { transform:translateY(-1px); box-shadow:0 16px 30px rgba(10,92,255,.30); }
        .primary:active { transform:scale(.985); } .primary:disabled { opacity:.58; box-shadow:none; cursor:not-allowed; }
        .forgot { background:none; border:0; font-size:12px; color:#0a5cff; cursor:pointer; justify-self:center; font-weight:700; padding:8px; }
        .error { background:#fff1f1; border:1px solid #ffd7d7; padding:11px 12px; border-radius:13px; font-size:13px; color:#a02020; font-weight:650; }
        .hint { font-size:13px; color:#667085; margin:0; }
        .roomList { display:grid; gap:8px; margin-top:6px; }
        .roomRow { display:flex; justify-content:space-between; align-items:center; background:#f5f8fd; padding:10px 12px; border-radius:14px; gap:10px; color:#0b1220; }
        .roomCode { font-weight:800; letter-spacing:1px; }
        .danger { border:0; background:#e9f1ff; color:#0a5cff; padding:10px 12px; border-radius:12px; cursor:pointer; font-weight:800; }
        .loadingOverlay { position:fixed; inset:0; z-index:999999; background:rgba(3,17,47,.56); backdrop-filter:blur(12px); display:grid; place-items:center; }
        .loadingCard { display:grid; place-items:center; gap:12px; padding:20px 24px; border-radius:22px; background:#fff; box-shadow:0 24px 70px rgba(0,0,0,.28); }
        .spinnerRing { width:86px; height:86px; border-radius:50%; border:4px solid #dbe8ff; border-top-color:#0a5cff; display:grid; place-items:center; animation:spin .9s linear infinite; }
        .logo { width:54px; height:54px; border-radius:17px; display:grid; place-items:center; font-weight:900; color:#fff; background:linear-gradient(145deg,#071b3a,#0a5cff); animation:unspin .9s linear infinite; }
        .loadingText { font-weight:750; color:#344054; font-size:13px; }
        @keyframes spin { to { transform:rotate(360deg); } } @keyframes unspin { to { transform:rotate(-360deg); } }
        .brandMark { width:58px; height:58px; border-radius:18px; margin:0 auto 2px; display:grid; place-items:center; color:#fff; font-weight:850; letter-spacing:-1px; font-size:20px; background:linear-gradient(145deg,#071b3a,#0a5cff); box-shadow:0 14px 28px rgba(10,92,255,.24), inset 0 1px 0 rgba(255,255,255,.2); }
        .eyebrow { text-align:center; font-size:9px; letter-spacing:1.7px; color:#0a5cff; font-weight:850; margin-top:2px; }
        @media (max-width:520px){ .wrap{padding:16px}.panel{padding:24px 18px;border-radius:24px} h1{font-size:25px} }


        /* ===== REDESIGN PREMIUM ===== */
        .wrap {
          position: relative;
          overflow: hidden;
          background:
            radial-gradient(circle at 18% 12%, rgba(58, 141, 255, .38), transparent 30%),
            radial-gradient(circle at 82% 82%, rgba(13, 71, 161, .44), transparent 34%),
            linear-gradient(145deg, #031a3d 0%, #05285d 38%, #0a4db8 100%);
        }
        .wrap::before,
        .wrap::after {
          content: "";
          position: fixed;
          width: 420px;
          height: 420px;
          border-radius: 999px;
          filter: blur(70px);
          pointer-events: none;
          opacity: .22;
        }
        .wrap::before { top: -170px; right: -140px; background: #69a7ff; }
        .wrap::after { bottom: -210px; left: -120px; background: #0d5fc5; }
        .panel {
          position: relative;
          z-index: 1;
          width: min(430px, 100%);
          padding: 30px;
          border-radius: 28px;
          background: rgba(255,255,255,.97);
          border: 1px solid rgba(255,255,255,.7);
          box-shadow: 0 28px 90px rgba(0, 17, 51, .36), inset 0 1px 0 rgba(255,255,255,.9);
          backdrop-filter: blur(24px) saturate(140%);
          gap: 13px;
        }
        .brandMark {
          width: 62px;
          height: 62px;
          margin: 0 auto 2px;
          border-radius: 19px;
          background: linear-gradient(145deg, #1468df, #073b8c 65%, #031a3d);
          color: #fff;
          display: grid;
          place-items: center;
          position: relative;
          box-shadow: 0 14px 30px rgba(10,77,184,.28), inset 0 1px 0 rgba(255,255,255,.32);
        }
        .brandMonogram { font-weight: 900; font-size: 20px; letter-spacing: -.5px; }
        .brandPulse {
          position: absolute;
          right: 8px;
          bottom: 8px;
          width: 8px;
          height: 8px;
          border-radius: 999px;
          background: #78b2ff;
          border: 2px solid #fff;
        }
        .eyebrow {
          text-align: center;
          font-size: 10px;
          line-height: 1;
          letter-spacing: 1.8px;
          font-weight: 850;
          color: #0a4db8;
          margin-top: 4px;
        }
        h1 { font-size: 26px; letter-spacing: -.8px; color: #07152c; }
        .gameTag { color: #63728a; font-size: 12px; font-weight: 600; }
        input, .modalInput {
          min-height: 50px;
          border-radius: 15px;
          border: 1px solid #d9e4f2;
          background: #f9fbfe;
          color: #0b1220;
          padding: 0 15px;
          font-weight: 650;
          transition: border-color .18s ease, box-shadow .18s ease, background .18s ease;
        }
        input:focus, .modalInput:focus {
          border-color: #2f80ed;
          background: #fff;
          box-shadow: 0 0 0 4px rgba(47,128,237,.11);
        }
        .seg, .roles {
          padding: 4px;
          gap: 4px;
          border-radius: 16px;
          background: #edf3fb;
          border: 1px solid #e1e9f4;
        }
        .seg button, .roles button {
          border: 0;
          min-height: 42px;
          border-radius: 12px;
          background: transparent;
          color: #53647d;
          font-weight: 760;
          transition: .18s ease;
        }
        .seg button.active, .roles button.active {
          background: #fff !important;
          color: #073b8c !important;
          box-shadow: 0 4px 14px rgba(14,45,89,.10);
        }
        .primary {
          min-height: 50px;
          border-radius: 15px;
          background: linear-gradient(180deg, #1468df, #0a4db8);
          box-shadow: 0 10px 22px rgba(10,77,184,.22), inset 0 1px 0 rgba(255,255,255,.2);
          transition: transform .15s ease, box-shadow .15s ease, filter .15s ease;
        }
        .primary:hover { filter: brightness(1.04); box-shadow: 0 13px 28px rgba(10,77,184,.27); }
        .primary:active { transform: translateY(1px) scale(.995); }
        .forgot { text-decoration: none; color: #0a4db8; padding: 8px; border-radius: 10px; }
        .forgot:hover { background: #eef5ff; }
        .error {
          background: #fff1f1;
          border: 1px solid #ffd6d6;
          color: #a61b1b;
          font-weight: 700;
        }
        .loadingOverlay { background: rgba(3, 26, 61, .58); }
        .loadingCard { border-radius: 24px; border: 1px solid rgba(255,255,255,.7); }
        .spinnerRing { border-color: rgba(47,128,237,.18); border-top-color: #1468df; }
        .roomRow { background: #f4f7fb; border: 1px solid #e2e9f3; }
        .danger { background: #d92d20; }
        @media (max-width: 520px) {
          .panel { padding: 22px 18px; border-radius: 24px; }
          .wrap { padding: 14px; }
        }
      `}</style>
    </main>
  );
}

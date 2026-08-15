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
          min-height: 100vh;
          display: grid;
          place-items: center;
          background: linear-gradient(
            160deg,
            #0b5d4a 0%,
            #08483b 45%,
            #052f28 100%
          );
          font-family: system-ui;
          padding: 18px;
        }

        /* LOADING */
        .loadingOverlay {
          position: fixed;
          inset: 0;
          z-index: 999999;
          background: rgba(0, 0, 0, 0.25);
          backdrop-filter: blur(6px);
          display: grid;
          place-items: center;
        }
        .loadingCard {
          display: grid;
          place-items: center;
          gap: 12px;
          padding: 18px 22px;
          border-radius: 22px;
          background: rgba(255, 255, 255, 0.92);
          box-shadow: 0 24px 70px rgba(0, 0, 0, 0.25);
        }
        .spinnerRing {
          width: 86px;
          height: 86px;
          border-radius: 50%;
          border: 4px solid rgba(138, 5, 190, 0.25);
          border-top-color: #ffffff;
          display: grid;
          place-items: center;
          animation: spin 0.9s linear infinite;
        }
        .logo {
          width: 54px;
          height: 54px;
          border-radius: 18px;
          display: grid;
          place-items: center;
          font-weight: 1000;
          color: #fff;
          background: linear-gradient(
            160deg,
            #0b5d4a 0%,
            #08483b 55%,
            #052f28 100%
          );
          box-shadow: 0 14px 40px rgba(106, 0, 168, 0.22);
          animation: unspin 0.9s linear infinite;
        }
        .loadingText {
          font-weight: 800;
          color: #333;
          font-size: 13px;
        }
        @keyframes spin {
          to {
            transform: rotate(360deg);
          }
        }
        @keyframes unspin {
          to {
            transform: rotate(-360deg);
          }
        }

        .panel {
          width: min(380px, 100%);
          padding: 26px;
          border-radius: 22px;
          background: rgba(255, 255, 255, 0.82);
          backdrop-filter: blur(14px);
          color: #111;
          display: grid;
          gap: 14px;
          box-shadow: 0 20px 50px rgba(0, 0, 0, 0.25);
        }

        h1 {
          margin: 0 0 4px;
          font-size: 22px;
          text-align: center;
          font-weight: 800;
          color: #2d2d2d;
        }

        .gameTag {
          margin: 0 0 10px;
          text-align: center;
          color: #6b7c76;
          font-size: 11px;
          font-weight: 700;
        }

        input {
          padding: 13px 14px;
          border-radius: 14px;
          border: 1px solid #e5e5e5;
          outline: none;
          font-size: 14px;
          background: #fff;
          color: #111;
        }
        input::placeholder {
          color: #999;
        }

        .seg,
        .roles {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 8px;
        }

        .seg button,
        .roles button {
          padding: 11px;
          border-radius: 14px;
          border: 1px solid #e5e5e5;
          cursor: pointer;
          background: #fff;
          color: #444;
          font-weight: 600;
        }

        .active {
          background: #0b5d4a !important;
          color: #fff !important;
          border-color: #0b5d4a !important;
        }

        .primary {
          background: #0b5d4a;
          color: #fff;
          padding: 12px;
          border-radius: 16px;
          border: none;
          font-weight: 800;
          cursor: pointer;
        }
        .primary:disabled {
          opacity: 0.7;
          cursor: not-allowed;
        }

        .forgot {
  background: none;
  border: none;
  font-size: 12px;
  color: #08483b;
  text-decoration: underline;
  cursor: pointer;
  justify-self: center;
  font-weight: 600;
}

.forgot:hover {
  color: #0b5d4a;
}
        .error {
          background: rgba(0, 0, 0, 0.35);
          padding: 10px;
          border-radius: 12px;
          font-size: 13px;
          color: #fff;
        }

        .hint {
          font-size: 13px;
          color: #333;
          margin: 0;
        }

        .modalInput {
          padding: 12px;
          border-radius: 14px;
          border: 1px solid #e7e7e7;
          outline: none;
        }

        .roomList {
          display: grid;
          gap: 8px;
          margin-top: 6px;
        }

        .roomRow {
          display: flex;
          justify-content: space-between;
          align-items: center;
          background: #f6f6f6;
          padding: 10px 12px;
          border-radius: 14px;
          gap: 10px;
        }

        .roomCode {
          font-weight: 800;
          letter-spacing: 1px;
        }

        .danger {
          border: none;
          background: #08483b;
          color: #fff;
          padding: 10px 12px;
          border-radius: 12px;
          cursor: pointer;
          font-weight: 800;
        }
      `}</style>
    </main>
  );
}

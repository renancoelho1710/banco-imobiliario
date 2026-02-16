export default function Loading() {
  return (
    <div className="biLoading">
      <div className="biCard" aria-label="Loading">
        <div className="biRing">
          <img className="biLogo" src="/favicon.ico" alt="Logo" />
        </div>
      </div>

      <style>{`
        .biLoading{
          min-height:100vh;
          display:grid;
          place-items:center;
          background:#f2f2f7;
        }
        .biCard{
          width:140px;
          height:140px;
          border-radius:22px;
          background:rgba(255,255,255,.92);
          box-shadow:0 18px 50px rgba(0,0,0,.18);
          display:grid;
          place-items:center;
          backdrop-filter:blur(10px);
        }
        .biRing{
          width:86px;
          height:86px;
          border-radius:999px;
          display:grid;
          place-items:center;
          position:relative;
        }
        .biRing:before{
          content:"";
          position:absolute;
          inset:-6px;
          border-radius:999px;
          border:6px solid rgba(138,5,190,.20);
          border-top-color:rgba(138,5,190,1);
          animation:spin .9s linear infinite;
        }
        .biLogo{
          width:44px;
          height:44px;
          border-radius:12px;
          background:#fff;
          padding:6px;
          border:1px solid rgba(0,0,0,.08);
        }
        @keyframes spin{ to{ transform:rotate(360deg);} }
      `}</style>
    </div>
  );
}

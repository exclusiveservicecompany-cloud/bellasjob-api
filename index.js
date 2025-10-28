const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { parseStringPromise } = require("xml2js");
const nodemailer = require("nodemailer");
const admin = require("firebase-admin");

// 🔐 Carrega credenciais do Firebase via variável de ambiente
const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const app = express();

app.use(cors({ origin: true }));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ⚙️ Variáveis de ambiente (Render)
const PAGSEGURO_EMAIL = process.env.PAGSEGURO_EMAIL;
const PAGSEGURO_TOKEN = process.env.PAGSEGURO_TOKEN;
const MAIL_USER = process.env.MAIL_USER;
const MAIL_PASS = process.env.MAIL_PASS;
const APP_URL = process.env.APP_URL;

// 📧 Configuração de envio de email
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: { user: MAIL_USER, pass: MAIL_PASS }
});

// 🔗 Função auxiliar para buscar transação PagSeguro
async function fetchPagSeguroTransaction(notificationCode) {
  const url = `https://ws.pagseguro.uol.com.br/v3/transactions/notifications/${encodeURIComponent(notificationCode)}?email=${encodeURIComponent(PAGSEGURO_EMAIL)}&token=${encodeURIComponent(PAGSEGURO_TOKEN)}`;
  const resp = await axios.get(url, { responseType: "text" });
  const json = await parseStringPromise(resp.data, { explicitArray: false, ignoreAttrs: true });
  return json;
}

// 🧩 Rota principal de teste
app.get("/", (req, res) => {
  res.send("✅ BellasJob API está rodando!");
});

// 💳 Webhook do PagSeguro
app.post("/pagseguro-webhook", async (req, res) => {
  try {
    const notificationCode = req.body.notificationCode || req.query.notificationCode;
    if (!notificationCode) return res.status(400).send("missing notificationCode");

    const txJson = await fetchPagSeguroTransaction(notificationCode);
    const transaction = txJson?.transaction;
    if (!transaction) return res.status(500).send("invalid pagseguro response");

    const status = transaction.status;
    const senderEmail = transaction.sender?.email;
    const reference = transaction.reference || null;

    console.log("🔔 Transação recebida:", { status, senderEmail, reference });

    // Status 3 = Paga, 4 = Disponível
    if (status === "3" || status === "4") {
      const senha = Math.random().toString(36).slice(-8);

      let userRecord;
      try {
        userRecord = await admin.auth().getUserByEmail(senderEmail);
        console.log("Usuário já existe:", senderEmail);
      } catch (err) {
        if (err.code === "auth/user-not-found") {
          userRecord = await admin.auth().createUser({
            email: senderEmail,
            password: senha
          });
          console.log("Usuário criado:", userRecord.uid);
        } else throw err;
      }

      await db.collection("users").doc(userRecord.uid).set(
        {
          email: senderEmail,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          pagseguro: {
            status,
            reference,
            transactionCode: transaction.code,
            grossAmount: transaction.grossAmount
          }
        },
        { merge: true }
      );

      const mailBody = `
Olá!

Seu acesso ao Bella's Job App foi ativado com sucesso! 💋
Acesse: ${APP_URL}

Login: ${senderEmail}
Senha: ${senha}

Atenciosamente,  
👑 Equipe MD App Solutions
`;

      await transporter.sendMail({
        from: `"MD App Solutions" <${MAIL_USER}>`,
        to: senderEmail,
        subject: "Seu acesso ao Bella’s Job App",
        text: mailBody
      });

      return res.json({ success: true, user: userRecord.uid });
    } else {
      await db.collection("pagseguro_logs").add({
        status,
        notificationCode,
        receivedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return res.json({ success: false, status });
    }
  } catch (err) {
    console.error("❌ Erro no PagSeguro webhook:", err);
    res.status(500).send("server error");
  }
});

// 🚀 Porta e host configurados para o Render
const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { parseStringPromise } = require("xml2js");
const nodemailer = require("nodemailer");
const admin = require("firebase-admin");

admin.initializeApp({
  credential: admin.credential.cert(require("./firebase-key.json")),
});

const db = admin.firestore();
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// VARIÁVEIS DE AMBIENTE
const PAGSEGURO_EMAIL = process.env.PAGSEGURO_EMAIL;
const PAGSEGURO_TOKEN = process.env.PAGSEGURO_TOKEN;
const MAIL_USER = process.env.MAIL_USER;
const MAIL_PASS = process.env.MAIL_PASS;
const APP_URL = process.env.APP_URL || "https://bellasjob.netlify.app";

// EMAIL
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: { user: MAIL_USER, pass: MAIL_PASS },
});

async function fetchPagSeguroTransaction(notificationCode) {
  const url = `https://ws.pagseguro.uol.com.br/v3/transactions/notifications/${notificationCode}?email=${PAGSEGURO_EMAIL}&token=${PAGSEGURO_TOKEN}`;
  const response = await axios.get(url, { responseType: "text" });
  const json = await parseStringPromise(response.data, { explicitArray: false, ignoreAttrs: true });
  return json.transaction;
}

app.post("/pagseguro-webhook", async (req, res) => {
  try {
    const notificationCode = req.body.notificationCode || req.query.notificationCode;
    if (!notificationCode) return res.status(400).send("missing notificationCode");

    const transaction = await fetchPagSeguroTransaction(notificationCode);
    if (!transaction) return res.status(500).send("invalid pagseguro response");

    const status = transaction.status;
    const senderEmail = transaction.sender?.email;
    const reference = transaction.reference || null;

    if (status === "3" || status === "4") {
      const senha = Math.random().toString(36).slice(-8);

      let userRecord;
      try {
        userRecord = await admin.auth().getUserByEmail(senderEmail);
      } catch (err) {
        if (err.code === "auth/user-not-found") {
          userRecord = await admin.auth().createUser({
            email: senderEmail,
            password: senha,
          });
        } else throw err;
      }

      await db.collection("users").doc(userRecord.uid).set({
        email: senderEmail,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        pagseguro: {
          status,
          reference,
          transactionCode: transaction.code,
          grossAmount: transaction.grossAmount,
        },
      }, { merge: true });

      const mailBody = `
Olá!

Seu acesso ao Bella's Job App foi ativado com sucesso!
Acesse: ${APP_URL}

Login: ${senderEmail}
Senha: ${senha}

Atenciosamente,  
Equipe MD App Solutions
      `;

      await transporter.sendMail({
        from: `"MD App Solutions" <${MAIL_USER}>`,
        to: senderEmail,
        subject: "Seu acesso ao Bella’s Job App",
        text: mailBody,
      });

      return res.json({ success: true, user: userRecord.uid });
    }

    res.json({ success: false, status });
  } catch (error) {
    console.error("Erro PagSeguro webhook:", error);
    res.status(500).send("server error");
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

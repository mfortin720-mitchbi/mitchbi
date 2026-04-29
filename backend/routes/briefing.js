const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const router = express.Router();

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

router.post('/', async (req, res) => {
  try {
    const { email } = req.body;
    const today = new Date().toLocaleDateString('fr-CA', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });

    const message = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: `Tu es NexusIQ, l'assistant AI de MitchBI. Génère un briefing matinal sharp et concis pour ${email}, qui est à la fois data scientist, stratège digital, directeur BI, trader et gestionnaire de factures.

Aujourd'hui c'est le ${today}.

Structure ton briefing ainsi :
📈 MARCHÉS — Pulse rapide (S&P, BTC, tendance générale)
🎯 MARKETING DIGITAL — 2-3 insights actionnables du jour
📊 DONNÉES & BI — 2 priorités data à adresser
💼 BUSINESS — 1 alerte ou opportunité business
✦ INSIGHT DU JOUR — 1 pensée stratégique motivante

Sois direct, professionnel, comme un conseiller senior. Maximum 250 mots. En français.`
        }
      ]
    });

    res.json({ briefing: message.content[0].text });
  } catch (err) {
    console.error('Briefing error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const router = express.Router();

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

router.post('/', async (req, res) => {
  try {
    const { messages, email } = req.body;

    // Filtrer seulement les messages user/assistant pour l'API
    const apiMessages = messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role, content: m.content }));

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 1024,
      system: `Tu es NexusIQ, l'assistant AI personnel de ${email}. 
Tu es un conseiller senior expert dans les domaines suivants :
- Data Science & Business Intelligence (BigQuery, Snowflake, Python, SQL)
- Marketing Digital (Google Ads, GA4, Meta Ads, Shopify)
- Trading & Finance (actions, crypto, analyse technique)
- Stratégie digitale & croissance
- Scraping de site web ecommerce pour extraire exhaustivement les données produits

Tu es direct, précis et professionnel — comme un conseiller de haut niveau.
Tu réponds toujours en français sauf si on te parle en anglais.
Tu peux générer du code SQL, Python, des analyses, des stratégies, etc.`,
      messages: apiMessages
    });

    res.json({ response: response.content[0].text });
  } catch (err) {
    console.error('Assistant error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
const sqlite3 = require('sqlite3').verbose();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = 5001;

// Activer CORS pour permettre les requêtes depuis le frontend
app.use(cors());

// Middleware pour limiter l'accès à localhost
app.use((req, res, next) => {
    let clientIp = req.ip; // Adresse IP du client
    const allowedIps = ['127.0.0.1', '::1', '::ffff:127.0.0.1']; // IPs autorisées (IPv4, IPv6 et IPv4 encapsulée dans IPv6)

    // Normaliser l'adresse IP pour gérer les formats IPv4 encapsulés dans IPv6
    if (clientIp.startsWith('::ffff:')) {
        clientIp = clientIp.replace('::ffff:', ''); // Convertir ::ffff:127.0.0.1 en 127.0.0.1
    }

    if (!allowedIps.includes(clientIp)) {
        console.error(`Accès refusé pour l'IP : ${clientIp}`);
        return res.status(403).json({ error: 'Accès refusé. Cette API est limitée à localhost.' });
    }

    next(); // Passer au middleware suivant si l'IP est autorisée
});

// Ouvrir la base de données SQLite
const db = new sqlite3.Database('./data/puzzles.db');

// Endpoint pour charger un problème d'échecs au hasard
app.get('/problems', (req, res) => {
    const query = 'SELECT * FROM puzzles ORDER BY RANDOM() LIMIT 1';

    db.get(query, (err, row) => {
        if (err) {
            console.error('Erreur lors de la requête SQL :', err);
            return res.status(500).json({ error: 'Erreur lors du chargement du problème.' });
        }

        res.json(row); // Envoyer le problème au client
    });
});

// Démarrer le serveur
app.listen(PORT, () => {
    console.log(`Serveur backend démarré sur http://localhost:${PORT}`);
});
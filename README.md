# METRODOKU UNLIMITED EXTENSION

Extension de navigateur qui superpose les **pourcentages de rareté par station**
sur les grilles **archivées** de métrodoku (`https://metrodoku.fr/?archive-date=YYYY-MM-DD`).

## Fonctionnement

- Sur les pages `?archive-date=`, elle annote chaque case dès lors que l'entrée est valide (le badge apparaît en direct pendant la partie, comme sur la grille du jour) **et** chaque case révélée après la fin de partie, avec le % de joueurs ayant choisi la même station (étiqueté selon les paliers de rareté du site : *mythique*, *rare*, …)
- Les dates sans historique conservé (avant le 2026-04-24) reçoivent une seule
  note discrète « pas de statistiques pour cette date ».
- La page du jour (sans paramètre d'URL) reste la même.

## Vie privée

- **Strictement en lecture seule** : le seul appel au backend est le RPC anonyme
  en lecture seule `get_daily_rarity_snapshot` (un par date d'archive, mis en
  cache en mémoire pour la durée de vie de la page), plus deux récupérations
  statiques de même origine (`js/config.js`, `data/stations.json`).
- La clé **publiable** Supabase est découverte à l'exécution depuis le propre
  `js/config.js` du site et gardée **en mémoire uniquement**. Elle n'est jamais
  codée en dur, jamais écrite dans `localStorage`, `sessionStorage` ou
  `chrome.storage`.
- Aucune analytique, aucun pistage, aucun code distant (conforme à la CSP MV3,
  JS pur).
- L'appel RPC part en `fetch` simple depuis le contexte de la page, à l'identique
  de l'appel que la page du jour du site effectue elle-même (même clé publique,
  même politique CORS publique de Supabase).
- Rejouer une archive n'envoie jamais rien au site.

## Installation (Chromium : Chrome, Edge, Brave, Opera)

1. Téléchargez / dézippez ce dossier (`extension/`).
2. Ouvrez `chrome://extensions` (ou `edge://extensions`, `brave://extensions`).
3. Activez le **Mode développeur** (curseur, en haut à droite).
4. Cliquez sur **Charger l'extension non empaquetée** et sélectionnez le dossier
   `extension/`.
5. Ouvrez une grille archivée, jouez-la (ou cliquez *abandonner*), puis cliquez
   sur une case pour parcourir les solutions. Les pourcentages apparaissent à
   côté de chaque station, et sur les cases que vous avez jouées.

**URLs d'archive :** chaque grille archivée est adressable via
`https://metrodoku.fr/?archive-date=YYYY-MM-DD` (ex.
`https://metrodoku.fr/?archive-date=2026-10-28`). Des statistiques existent pour
les dates à partir du 2026-04-24.

## Hook de débogage

Une fois un instantané appliqué, le script de contenu expose un objet
d'introspection en lecture seule sur la page (visible dans les DevTools ;
sélectionnez le contexte de l'extension dans le menu déroulant de contexte de la
console) :

```js
window.__metrodokuArchiveStats
// { dateKey: "2026-10-28",
//   totals: { "L1:RER": 123 },
//   shares: { "L1:RER": { "<stationId>": 12.3, ... }, ... } }
```

## Fichiers

| Fichier | Rôle |
|---|---|
| `manifest.json` | Manifest V3 ; script de contenu sur `https://metrodoku.fr/*` ; permission hôte unique (le site lui-même) |
| `content.js` | détection du mode archive + client RPC en lecture seule + injection DOM |
| `icons/` | icônes PNG générées (16/48/128) |
| `CHANGELOG.md` | journal des modifications |

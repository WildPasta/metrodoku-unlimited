# Changelog

- **1.0.0** - version initiale : tri de la modale solutions ignorant les enfants non-`.solutions-item` (plus de risque de boucle de mutations infinie) ; annotation des lignes auto-réparable après `resetDom` (plus de pourcentages périmés via `data-mxd-annotated`) ; détection de navigation SPA par sondage de l'URL chaque seconde (fiable, indépendante du DOM) ; suppression de la permission hôte Supabase, inutilisée en MV3.

# PRD — StageIn

## Product Requirements Document

Le public rejoint temporairement la performance depuis son mobile

**Version :** 0.2 — Draft MVP

**Date :** 6 août 2026

**Propriétaire :** StageIn — projet initié par RAMAS

**Statut :** À valider

| **Vision.** Permettre à une personne du public, sur place ou à distance, d'entrer temporairement dans la performance grâce à une interaction mobile immédiate, spectaculaire et sûre. |
|--------------------------------------------------------------------------------------------------------------------------------------------------------------|

# 1. Résumé exécutif

StageIn est une plateforme de participation musicale en temps réel. Les participants rejoignent une session depuis un navigateur mobile, via un QR code ou un lien. Lorsqu'une loterie est lancée, une seule personne est sélectionnée. Son écran d'attente devient alors un pad XY qui pilote deux macros musicales pendant une durée limitée. Les valeurs sont transmises à un relais, sécurisées et lissées, puis envoyées au Norns qui les convertit en MIDI CC ou OSC vers le setup de RAMAS.

La plateforme est indépendante du canal d'acquisition : elle doit fonctionner dans un concert physique, sur Twitch, ou avec un public hybride. Twitch, OBS et les écrans de scène sont des connecteurs optionnels.

# 2. Problème

## 2.1 Situation actuelle

- Le public regarde le live mais intervient peu dans la création musicale elle-même.

- Les solutions basées uniquement sur le chat sont limitées, lentes et dépendantes d'une plateforme.

- Donner un contrôle MIDI direct au public peut dégrader le mix ou casser la performance.

- En concert physique, il n'existe pas de mécanisme simple pour choisir équitablement une personne et lui donner un contrôle temporaire.

## 2.2 Opportunité

Créer un rituel scénique identifiable : le public rejoint une loterie, une personne est invitée à « entrer sur scène » pendant quelques secondes, et son geste sur téléphone influence réellement la performance tout en restant encadré par les artistes.

## 2.3 Proposition de valeur

**StageIn transforme le téléphone du public en pass temporaire vers la scène.** L'organisateur garde le contrôle du moment, de la durée et des paramètres accessibles ; le participant bénéficie d'une expérience instantanée, sans application ni compte.

# 3. Objectifs et non-objectifs

| **Type**          | **Éléments**                                                                                                                                                                                                |
|-------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Objectifs MVP     | Rejoindre sans compte ; tirer une personne ; activer un pad XY ; transmettre deux valeurs en temps réel ; limiter et lisser les sorties ; permettre un kill switch ; fonctionner en physique et à distance. |
| Objectifs produit | Créer un moment mémorable, compréhensible en moins de 10 secondes, répétable pendant un live et réutilisable par différents artistes ou événements.                                                       |
| Non-objectifs MVP | Séquenceur collaboratif ; contrôle du volume master ; application native ; monétisation ; profils persistants ; support de plusieurs gagnants simultanés.                                                   |

# 4. Utilisateurs et rôles

| **Rôle**            | **Besoin principal**                           | **Droits**                                                                                             |
|---------------------|------------------------------------------------|--------------------------------------------------------------------------------------------------------|
| Artiste / Hôte      | Garder le contrôle musical et scénique         | Créer une session, configurer les macros, ouvrir/fermer la loterie, tirer, arrêter, révoquer.          |
| Participant         | Rejoindre facilement et savoir s'il peut jouer | Entrer dans la file, attendre, recevoir le pad si sélectionné, contrôler pendant la fenêtre autorisée. |
| Public              | Comprendre ce qui se passe                     | Voir le nombre de participants, le compte à rebours, le pseudo gagnant et la durée restante.           |
| Opérateur technique | Diagnostiquer sans interrompre le live         | Voir l'état du relais, du Norns, la latence et les erreurs de connexion.                               |

# 5. Expérience cible

## 5.1 Parcours participant

1.  Le participant scanne le QR code ou ouvre le lien de la session.

2.  Il choisit un pseudo facultatif et appuie sur « Rejoindre la loterie ».

3.  La page confirme son inscription et reste connectée en attente.

4.  L'hôte lance un compte à rebours puis le tirage.

5.  Si la personne gagne, son téléphone vibre et affiche immédiatement le pad XY.

6.  Elle déplace le point pendant 20 à 30 secondes et entend son influence sur le son.

7.  À la fin, le pad se verrouille et la page propose de rejoindre un prochain tirage.

## 5.2 Parcours artiste

1.  Créer ou reprendre une session live.

2.  Choisir le preset de contrôle : par exemple filtre + delay.

3.  Définir la durée, les plages MIDI, la vitesse maximale et la valeur de retour.

4.  Afficher le QR code et ouvrir les inscriptions.

5.  Lancer la loterie et superviser la session gagnante.

6.  Couper ou reprendre le contrôle à tout instant depuis le Norns ou l'interface hôte.

# 6. Périmètre fonctionnel MVP

| **ID** | **Exigence**                                                                    | **Priorité** |
|--------|---------------------------------------------------------------------------------|--------------|
| FR-01  | Créer une session avec un identifiant et une URL courte uniques.                | Must         |
| FR-02  | Afficher un QR code rejoignant directement la session.                          | Must         |
| FR-03  | Rejoindre depuis Safari/Chrome mobile sans installation ni compte.              | Must         |
| FR-04  | Maintenir la présence et retirer les connexions expirées.                       | Must         |
| FR-05  | Ouvrir, fermer et réinitialiser la loterie.                                     | Must         |
| FR-06  | Tirer aléatoirement une seule session éligible et annoncer le gagnant.          | Must         |
| FR-07  | Activer le pad XY uniquement pour la session gagnante.                          | Must         |
| FR-08  | Limiter la validité du contrôle à une durée configurable.                       | Must         |
| FR-09  | Transmettre X et Y en temps réel avec numéro de séquence et horodatage.         | Must         |
| FR-10  | Configurer deux mappings MIDI CC/OSC avec plages min/max et inversion.          | Must         |
| FR-11  | Lisser les valeurs et limiter leur vitesse de variation.                        | Must         |
| FR-12  | Fournir un arrêt d'urgence physique sur le Norns et logiciel côté hôte.         | Must         |
| FR-13  | Revenir à une valeur sûre à la fin ou en cas de déconnexion.                    | Must         |
| FR-14  | Afficher l'état : participants, gagnant, temps restant, connexion Norns.        | Should       |
| FR-15  | Fournir une vue publique intégrable à OBS ou projetable sur scène.              | Should       |
| FR-16  | Proposer des connecteurs optionnels Twitch pour annoncer le lien et le gagnant. | Could        |

# 7. Règles métier

- Une session navigateur active correspond à une entrée de loterie ; un même appareil ne peut avoir qu'une entrée active.

- Le gagnant est choisi parmi les participants connectés et éligibles au moment exact du tirage.

- Une autorisation de contrôle est liée à une session, un gagnant, un délai d'activation et une durée d'utilisation.

- Une seule autorisation peut être active par session live.

- Les valeurs reçues d'un participant non autorisé, expiré ou révoqué sont ignorées.

- La sécurité musicale est appliquée côté Norns, même si le serveur a déjà validé les valeurs.

- À la perte de connexion, le Norns maintient brièvement la dernière valeur puis revient progressivement au preset sûr.

# 8. Contrôle musical

| **Paramètre**     | **Valeur MVP recommandée**                                      |
|-------------------|-----------------------------------------------------------------|
| Durée de contrôle | 30 s, configurable de 10 à 60 s                                 |
| Fréquence mobile  | 15 événements/s maximum                                         |
| Sortie            | Deux CC MIDI 0-127 ou deux paramètres OSC                       |
| Plages            | Min/max configurables séparément pour X et Y                    |
| Lissage           | Rampe 100 à 500 ms, configurable                                |
| Vitesse maximale  | Variation limitée par seconde                                   |
| Fin de session    | Retour progressif vers une valeur sûre ou maintien selon preset |
| Kill switch       | K2 ou K3 sur Norns, plus bouton dans l'interface hôte           |

| **Recommandation.** Le pad ne doit pas piloter le volume master. Pour le premier test : X = ouverture de filtre dans une plage limitée ; Y = send delay ou reverb. |
|--------------------------------------------------------------------------------------------------------------------------------------------------------------------|

# 9. Architecture cible

L'architecture sépare l'expérience publique, l'autorisation temps réel et la sécurité musicale locale.

| **Composant**     | **Responsabilités**                                                                       |
|-------------------|-------------------------------------------------------------------------------------------|
| Web mobile        | Inscription, salle d'attente, vibration, pad XY, reconnexion courte.                      |
| Interface hôte    | Configuration, QR code, loterie, supervision, arrêt d'urgence.                            |
| Relais temps réel | Sessions, présence, tirage, autorisations temporaires, WebSocket, journal technique.      |
| Client Norns      | Connexion sortante, validation, lissage, mapping, MIDI/OSC, affichage local, kill switch. |
| Vue publique      | Compteur, compte à rebours, gagnant, temps restant ; intégration OBS/projection.          |
| Connecteurs       | Twitch ou autres canaux pour distribuer le lien et annoncer les événements.               |

## 9.1 Flux temps réel

1.  Le téléphone envoie {x, y, seq, timestamp} au relais via WebSocket.

2.  Le relais vérifie la session, l'autorisation et l'expiration, puis publie la valeur au canal Norns.

3.  Le Norns rejette les messages invalides ou anciens, applique clamp, slew et mapping.

4.  Le Norns émet les CC MIDI/OSC et publie son état pour l'interface hôte.

## 9.2 États principaux

| **État** | **Description**                     | **Transition suivante** |
|----------|-------------------------------------|-------------------------|
| CLOSED   | Inscriptions fermées                | OPEN                    |
| OPEN     | Participants admis                  | DRAWING ou CLOSED       |
| DRAWING  | Compte à rebours et sélection       | AWARDED                 |
| AWARDED  | Gagnant informé, délai d'activation | ACTIVE ou EXPIRED       |
| ACTIVE   | Pad autorisé et contrôle transmis   | ENDED ou REVOKED        |
| ENDED    | Retour à la valeur sûre             | OPEN ou CLOSED          |

# 10. Exigences non fonctionnelles

| **ID** | **Exigence**                      | **Cible MVP**                                                    |
|--------|-----------------------------------|------------------------------------------------------------------|
| NFR-01 | Latence geste -\> réception Norns | P95 \< 250 ms sur réseau stable                                  |
| NFR-02 | Disponibilité pendant une session | 99,5 % sur la fenêtre de live                                    |
| NFR-03 | Capacité                          | 200 participants connectés par session MVP                       |
| NFR-04 | Compatibilité                     | Deux dernières versions de Safari iOS et Chrome Android          |
| NFR-05 | Reconnexion                       | Récupération de session après coupure \< 10 s                    |
| NFR-06 | Sécurité                          | TLS, jetons opaques, expiration stricte, limitation de débit     |
| NFR-07 | Résilience musicale               | Aucune valeur brute ne contourne les limites locales Norns       |
| NFR-08 | Vie privée                        | Pas de compte requis ; données minimales ; pseudonyme facultatif |

# 11. Sécurité, abus et confidentialité

- Identifiants de session et jetons d'autorisation générés aléatoirement et non prédictibles.

- Jeton gagnant inutilisable après expiration, révocation ou fin de session.

- Rate limiting par session et appareil ; messages dupliqués ou désordonnés ignorés.

- Validation de schéma et bornage de X/Y côté serveur et côté Norns.

- Aucun accès entrant au réseau du lieu : le Norns ouvre une connexion WebSocket sortante.

- Collecte minimale : identifiant de navigateur, pseudo facultatif, événements techniques temporaires.

- Possibilité de bloquer une session abusive et de régénérer immédiatement le QR code.

# 12. Interface Norns

L'écran Norns doit rester lisible en situation de scène et fonctionner sans dépendre d'un ordinateur.

| **Contrôle** | **Action proposée**                                          |
|--------------|--------------------------------------------------------------|
| E1           | Choisir le preset musical                                    |
| E2           | Régler la durée de contrôle                                  |
| E3           | Régler l'intensité globale / la plage des macros             |
| K1           | Navigation / aide                                            |
| K2           | Ouvrir ou lancer le tirage                                   |
| K3           | Maintien = ARM ; relâchement ou double appui = KILL immédiat |

Affichage minimal : état réseau, nombre de participants, preset actif, gagnant, temps restant, X/Y cible, X/Y sortie et état ARMED/KILLED.

# 13. Indicateurs de succès

| **Indicateur**        | **Cible pilote**                                             |
|-----------------------|--------------------------------------------------------------|
| Taux de participation | \> 10 % du public exposé rejoint une loterie                 |
| Temps d'accès         | Médiane \< 20 s entre scan et inscription                    |
| Activation gagnant    | \> 80 % des gagnants touchent le pad dans les 10 s           |
| Fiabilité             | \> 95 % des sessions de contrôle se terminent sans erreur    |
| Sécurité live         | 0 incident affectant le volume master ou interrompant le set |
| Engagement            | Au moins 3 activations réussies sur un live test             |

# 14. Critères d'acceptation MVP

- Un participant rejoint une session en moins de trois actions après ouverture du lien.

- Le système sélectionne exactement une personne parmi les sessions actives.

- Seul le gagnant voit et peut utiliser le pad XY actif.

- Le Norns reçoit X/Y, applique les limites et émet deux CC MIDI vérifiables.

- L'autorisation cesse automatiquement à la seconde prévue.

- Le kill switch bloque les nouvelles valeurs en moins de 100 ms côté Norns.

- Une déconnexion du téléphone ou du relais déclenche le comportement sûr configuré.

- Le même build fonctionne avec accès par QR code en salle et par lien sur Twitch.

# 15. Plan de livraison

| **Phase**            | **Contenu**                                                       | **Sortie attendue**                  |
|----------------------|-------------------------------------------------------------------|--------------------------------------|
| P0 - Prototype local | Page pad XY -\> WebSocket local -\> Norns -\> MIDI CC             | Validation du ressenti et du mapping |
| P1 - MVP privé       | Session, QR code, présence, loterie, autorisation, interface hôte | Test RAMAS en répétition             |
| P2 - Pilote live     | Relais hébergé, vue publique, métriques, durcissement sécurité    | Test Twitch puis petit concert       |
| P3 - Beta            | Presets, reconnexion, connecteur Twitch/OBS, meilleure modération | Utilisation répétée en live          |

# 16. Risques et réponses

| **Risque**                          | **Impact**                  | **Réponse**                                                                               |
|-------------------------------------|-----------------------------|-------------------------------------------------------------------------------------------|
| Wi-Fi/mobile médiocre dans la salle | Pad saccadé ou inaccessible | QR léger, reconnexion, interpolation Norns, réseau public séparé si possible.             |
| Gagnant ne réagit pas               | Temps mort scénique         | Délai d'activation de 10 s puis nouveau tirage automatique.                               |
| Gestes extrêmes                     | Son agressif                | Plages limitées, slew, presets validés, kill switch.                                      |
| Spam / multi-inscription            | Loterie moins équitable     | Une entrée par appareil, présence active, rate limiting ; contrôle renforcé après pilote. |
| Relais indisponible                 | Interaction impossible      | Norns reste musicalement autonome ; désactivation claire et reprise manuelle du live.     |
| Expérience incomprise               | Faible participation        | Message unique, compte à rebours, démonstration visuelle du pad et feedback public.       |

# 17. Identité produit et décisions ouvertes

- **Nom retenu : StageIn.** Il évoque l'entrée temporaire du public dans l'espace de performance.

- Signature de travail : **StageIn — Join the performance. Shape the moment.**

- Durée par défaut : 20 ou 30 secondes.

- Le gagnant peut-il participer de nouveau au tirage suivant ?

- Le pad démarre-t-il au centre, à la valeur musicale courante ou à une position imposée ?

- Quel premier appareil et quels CC seront utilisés pour le pilote : Syntakt, Digitakt, Microcosm ou autre ?

- Le tirage doit-il être automatique, manuel ou proposer les deux modes ?

- Faut-il conserver des statistiques entre plusieurs lives ou rester sans compte en V1 ?

# 18. Hypothèses techniques

- Le Norns peut exécuter un client Lua ou un petit service compagnon capable de maintenir une connexion sortante sécurisée.

- Le setup MIDI dispose d'un port ou d'un routage disponible pour deux CC contrôlés par le Norns.

- Le lieu ou la connexion du Norns permet un accès Internet sortant stable ; le public utilise son propre accès mobile ou le Wi-Fi du lieu.

- Le premier pilote vise une seule session StageIn opérée par RAMAS et 200 participants maximum.

| **Décision recommandée pour lancer le prototype.** Tester d'abord X = filtre et Y = quantité de delay, 30 secondes, 15 Hz, plages limitées, retour progressif au centre et kill switch maintenu sur K3. |
|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|

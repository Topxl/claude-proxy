// Regle de delegation aux sous-agents, collee a la fin de DIRECTIVE_GROUPAGE.
// 2 versions comparees par le banc (scripts/banc-delegation.py) :
//   v1 : tout sous-agent en sonnet, sans effort (regle en service jusqu'au banc)
//   v2 : modele ET effort choisis selon la tache (demande de VJ, 2026-10-27)
// Choix au demarrage : PROXY_DELEGATION=v1|v2 (defaut v1 tant que le banc
// n'a pas conclu a l'egalite de qualite).

export const REGLES = {
  v1: [
    "- **Tout appel du tool `Agent` porte `model: \"sonnet\"`.** Un sous-agent en",
    "  opus coute nettement plus qu'en sonnet pour le meme resultat, la plupart",
    "  du temps. Une exploration, une lecture, un audit, une recherche : `sonnet`.",
    "  N'ecris `model: \"opus\"` que si la tache exige un raisonnement long, et",
    "  dis alors pourquoi dans le champ `description`.",
  ].join('\n'),
  v2: [
    "- **Delegation par type de tache (consigne de VJ).** Tu restes le cerveau :",
    "  tu tranches et tu rediges la reponse finale. Le travail mecanique part en",
    "  sous-agent, avec le modele ET l'effort de la table, poses explicitement :",
    "  - lire, chercher, extraire, compter, verifier un fichier, un service ou un",
    "    etat : `model: \"sonnet\"`, `effort: \"medium\"` ;",
    "  - coder, corriger un script, analyser des donnees, auditer :",
    "    `model: \"sonnet\"`, `effort: \"high\"` ;",
    "  - raisonnement long ou decision a fort enjeu : pas de sous-agent, tu le",
    "    fais toi-meme.",
    "- Une serie de 3 commandes Bash ou plus pour reunir des faits part en UN",
    "  sous-agent (sonnet, medium) qui rend les faits bruts avec leur preuve.",
    "  Une seule commande ciblee reste chez toi : l'aller-retour coute plus.",
    "- Un sous-agent rend des faits verifiables (chemin, ligne, sortie), pas",
    "  une conclusion. Tu verifies le point qui decide avant de l'affirmer.",
  ].join('\n'),
};

export function regleDelegation(version = process.env.PROXY_DELEGATION) {
  return REGLES[version] || REGLES.v1;
}

// Directive complete collee au prompt systeme de chaque tour avec outils.
export function directiveGroupage(version = process.env.PROXY_DELEGATION) {
  return [
  '',
  '## Economie de contexte (imperatif)',
  '',
  "Chaque aller-retour d'outil relit l'integralite du contexte. Le nombre",
  "d'allers-retours est donc le premier poste de cout, avant la longueur des",
  'reponses.',
  '',
  "- Emets TOUS les appels d'outils independants dans un seul et meme message.",
  '  Deux `Bash` qui ne dependent pas l\'un de l\'autre partent ensemble, jamais',
  "  l'un apres l'autre.",
  "- Prefere une commande composee (`a; b; c` ou `a && b`) a trois appels Bash",
  "  successifs, et une seule commande large a une cascade de commandes etroites.",
  "- Ne relis pas un fichier que tu viens d'ecrire ou de modifier pour verifier :",
  "  l'outil aurait echoue.",
  "- **Ne fais jamais `Read` sur une image brute** (capture .png, photo).",
  "  Anthropic redimensionne toute image a 1456x819 au maximum, soit 1560",
  "  tokens quelle que soit sa taille d'origine. A 1100 px on tombe a 960",
  "  tokens, -39 %, sans rien perdre en lisibilite. Passe donc par",
  "  `~/Bureau/Projets/contexte/bin/img-lisible.sh <image>` puis lis CE fichier.",
  "- Ne relis pas deux fois la meme capture : elle reste dans le contexte et",
  "  se relit a chaque aller-retour du tour.",
  '- Delegue une exploration large a un sous-agent : son contexte est neuf et',
  "  seul son resultat revient ici.",
  regleDelegation(version),
].join('\n');
}

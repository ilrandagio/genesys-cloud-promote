/**
 * Riconoscimento degli ID Genesys Cloud nei contenuti (configurazioni di flow, JSON degli script,
 * configurazione Terraform esportata).
 *
 * Oltre ai GUID semplici, alcuni oggetti hanno un prefisso: le data action custom ("custom_-_<guid>")
 * e statiche ("static_-_<guid>"). Il prefisso fa parte dell'ID: va riconosciuto e sostituito per intero,
 * altrimenti una data action non viene mai trovata e nel porting si otterrebbe "custom_-_custom_-_...".
 */
export const ID_TOKEN_G = /(?:\b[a-z]+_-_)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Chiave di confronto di un ID (minuscolo, prefisso incluso) */
export const idKey = (id: string) => id.trim().toLowerCase();

/** Tutti gli ID (con eventuale prefisso) presenti in un testo, come chiavi */
export function idTokens(text: string): Set<string> {
  return new Set((text.match(ID_TOKEN_G) ?? []).map(idKey));
}

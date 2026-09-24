Versions log.

// @name         TAM Auto-Annahme (IB Thomée)
// @namespace    ib-thomee
// @version      0.10.0
// @description  Prüft "Veröffentlichte Aufträge" im TÜV SÜD TAM regelmäßig und nimmt Aufträge an, deren PLZ/Ort in der Ortsliste steht.
// @match        https://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
// @connect      docs.google.com
// @connect      googleusercontent.com
// @run-at       document-idle

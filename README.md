# Headless Viewer

Lehký bezrámečkový prohlížeč médií z webu postavený na Electronu. Otevře URL v čistém okně bez jakéhokoliv rozhraní prohlížeče a obrázek nebo video roztáhne na celé okno. Funguje na Windows, macOS i Linuxu.

## Jak to rozjet z repozitáře

Potřebujete [Node.js](https://nodejs.org/) 20 nebo novější (LTS instalátor stačí, `npm` je jeho součástí) a [Git](https://git-scm.com/).

```bash
git clone <adresa-repozitáře>
cd headless-viewer
npm install
npm start
```

Postup je stejný na všech systémech. Na Windows příkazy spusťte v PowerShellu nebo v příkazovém řádku. `npm install` při prvním spuštění stáhne Electron (zhruba 100–250 MB), takže chvíli trvá.

## Sestavení samostatné aplikace

Sestavujte na systému, pro který aplikaci chcete – build pro Windows na Windows, build pro macOS na Macu.

| Příkaz | Výsledek ve složce `dist/` |
| --- | --- |
| `npm run dist:win` | přenosný `.exe` (bez instalace) a instalátor `-setup.exe` |
| `npm run dist:mac` | `.dmg` a `.zip` |
| `npm run dist` | build pro systém, na kterém příkaz spouštíte |

Aplikace není digitálně podepsaná, takže Windows (SmartScreen) i macOS (Gatekeeper) při prvním spuštění zobrazí varování, které je potřeba potvrdit.

## Ovládání

Po spuštění zadejte URL a stiskněte `Enter` (chybějící `https://` se doplní), nebo použijte tlačítko **Vložit a otevřít**. Okno přesunete tažením za neviditelný pruh u horního okraje.

| Zkratka | Akce |
| --- | --- |
| `Esc` nebo `Ctrl+L` | zobrazí/skryje menu s řádkem pro URL, tlačítky Celá obrazovka a Zavřít okno |
| `F`, `F11` nebo dvojklik | celá obrazovka |
| `C` | přizpůsobit / vyplnit (`object-fit: contain` / `cover`) |
| `B` nebo `Ctrl+B` | režim prohlížení / režim médií |
| `R` nebo `Ctrl+R` | obnovit |
| `Alt+←` / `Alt+→` | zpět / vpřed v historii |
| `Ctrl+Q` nebo `Alt+F4` | ukončit |

Na macOS funguje místo `Ctrl` i `Cmd`. Jednopísmenné zkratky se nespouští, když píšete do textového pole na stránce.

## Přihlášení na webech

Cookies a přihlášení se ukládají trvale, takže po restartu zůstanete přihlášeni.

V režimu médií aplikace stránku upravuje (skryje posuvníky, roztáhne hlavní video nebo obrázek), což přihlašovací formuláře a běžné procházení rozbíjí. Proto:

1. Stiskněte `B` – stránka se zobrazí normálně.
2. Přihlaste se a najděte obrázek nebo video.
3. Stiskněte `B` znovu – médium se roztáhne na celé okno.

Přihlášení přes Google nemusí fungovat, Google ho ve vestavěných prohlížečích často blokuje.

## Struktura projektu

| Soubor | K čemu je |
| --- | --- |
| `main.js` | hlavní proces: okno, zkratky, CSS a JS vkládané do stránek |
| `index.html`, `renderer.js` | úvodní obrazovka a menu s řádkem pro URL |
| `preload.js` | most mezi oknem s UI a hlavním procesem |
| `webview-preload.js` | jednopísmenné zkratky a dvojklik uvnitř načtené stránky |

## Známá omezení

- Horních 28 px okna slouží k přesunu okna a nepropouští kliknutí do stránky (v režimu celé obrazovky se vypíná). Dvojklik na tento pruh okno maximalizuje.
- Na běžné stránce se roztáhne největší `<video>`, případně jediný `<img>`. Pokud je obrázků víc, otevřete přímý odkaz na soubor.
- Při načítání některých videí vypíše Electron do terminálu hlášku `GUEST_VIEW_MANAGER_CALL … ERR_FAILED`. Na přehrávání nemá vliv.

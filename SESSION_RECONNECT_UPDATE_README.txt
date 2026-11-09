AURUM — refresh session reconnection update

WHAT CHANGED
- After a successful Deriv or Exness connection, AURUM can restore that broker connection after refreshing the page in the same browser tab.
- Deriv PAT/App ID and Exness account login, server, MT5 password and bridge token are kept in browser sessionStorage only. They are not written to localStorage or sent to a cloud database by this feature.
- Disconnect and Sign out clear the session credentials. Closing/ending the browser tab session can also clear them. Use only on a device you control.
- Exness remains read-only; this does not enable or change broker order execution.

INSTALL INTO THE EXISTING WINDOWS APP
1. Stop the AURUM local API/bridge windows.
2. Extract this update ZIP into the existing AURUM project folder, allowing the included bridge/app.html, index.html, src/main.js, and tests/smoke.mjs files to overwrite their matching paths.
3. Start the local API/bridge again with your existing launcher.
4. Open the local app, connect the broker successfully once, then refresh the page to test reconnection.

IMPORTANT
- Existing Exness sessions cannot recover a password/token that was never stored by the previous version. Connect Exness once after installing this update.
- A Deriv PAT is saved only after Deriv accepts a successful connection. This update does not fix an invalid PAT or App ID.
- The update is local only: it does not deploy anything, change production infrastructure, modify the database, or expose the app publicly.

TEST ONLY. These files are not secrets and must never be trusted outside the platform's own tests.

They stand in for a company security tool that re-signs https traffic (tests/company-network*.test.ts):

  test-company-root.crt   a self-made root ("TEST ONLY Company Security Root (not a real CA)"). Its private key was thrown away
                          right after signing the leaf below, so nobody can make more certificates with it.
  test-company-leaf.crt   a server certificate signed by that root, for platform.test, app.test, localhost and 127.0.0.1
  test-company-leaf.key   the leaf's private key (test only, published on purpose)

Made with OpenSSL 3.2 on 2026-10-18, valid for 100 years:
  openssl req -x509 -newkey rsa:2048 -nodes -keyout root.key -out test-company-root.crt -days 36500 \
    -subj "/CN=TEST ONLY Company Security Root (not a real CA)" -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign"
  openssl req -newkey rsa:2048 -nodes -keyout test-company-leaf.key -out leaf.csr -subj "/CN=platform.test"
  openssl x509 -req -in leaf.csr -CA test-company-root.crt -CAkey root.key -CAcreateserial -out test-company-leaf.crt -days 36500 \
    -extfile leaf.ext   (basicConstraints=CA:FALSE, serverAuth, subjectAltName=DNS:platform.test,DNS:app.test,DNS:localhost,IP:127.0.0.1)

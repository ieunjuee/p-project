/* 첫 주소(index.html) 안내: 서버나 웹 주소로 열면 검증 홈(person.html)으로 보냅니다.
   파일을 더블클릭해서 열면(file:) 사람 화면은 데이터를 읽지 못하므로 기존 청구 단위 데모(legacy.html)로 보냅니다.
   server.mjs 의 보안 설정(CSP)이 페이지 안에 직접 쓴 스크립트를 막기 때문에 별도 파일로 둡니다. */
location.replace((location.protocol === 'file:' ? 'legacy.html' : 'person.html') + location.search + location.hash);

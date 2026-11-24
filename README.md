# Rede do Boi

App do pecuarista (mercado de gado + clube de vantagens) para Apuí e Santo Antônio do Matupi (AM).

- **Produtor**: entra só com o telefone, faz o cadastro uma vez, lança compra ou venda de gado com fotos e vídeos,
  funciona sem internet (envia sozinho quando conectar), recebe ofertas e mensagens, responde no app ou no WhatsApp.
- **Comprador (administrador)**: entra com telefone e senha, vê todos os lançamentos, faz ofertas, marca a situação
  (em negociação, visita técnica, negócio fechado), relatório com planilha e PDF, banners da tela inicial, vicinais e produtores.

## Como é feito

- `public/`: o app (PWA, HTML + JavaScript, sem etapa de build). Pode ser hospedado em qualquer site estático
  (GitHub Pages, Cloudflare Pages, Netlify).
  - `js/config.js`: endereço e chave do Supabase, WhatsApp da Rede do Boi. **Vazio = modo demonstração**
    (tudo fica no navegador, com dados de exemplo).
  - `js/app.js`: telas e regras do app. `js/api.js`: conversa com o servidor (e o servidor de demonstração).
  - `js/store.js`: dados no aparelho (IndexedDB): cache, fila de envio e fotos ainda não enviadas.
  - `sw.js`: guarda o app no aparelho para abrir sem internet.
- `supabase/`: banco de dados (PostgreSQL no Supabase).
  - `instalar.sql`: tudo junto, para colar no SQL Editor do Supabase (gerado de `schema.sql`, `storage.sql` e `seed.sql`).
  - As regras de segurança ficam no banco (RLS + gatilhos): o produtor só vê os próprios lançamentos, não muda
    status nem valor fechado; só administradores com senha veem tudo.

## Colocar no ar (uma vez)

1. Criar projeto no [Supabase](https://supabase.com) (região São Paulo).
2. SQL Editor > New query > colar `supabase/instalar.sql` > Run.
3. Authentication > Sign In / Providers > Email: **desligar "Confirm email"** (o login é só pelo telefone).
4. Project Settings > API: copiar *Project URL* e a chave *anon/publishable* para `public/js/config.js`.
5. Publicar a pasta `public/` (GitHub Pages: Settings > Pages > Deploy from branch, pasta `/public` via workflow incluído).
6. Primeiro administrador: entrar no app com o telefone e fazer o cadastro. Depois, no SQL Editor:
   `update perfis set admin = true where fone = '5597XXXXXXXXX';`
   Ao abrir o app de novo, ele pede para criar a senha. Os próximos administradores podem ser criados pelo próprio app
   (Painel > Produtores e administradores).

## Testar localmente

```
cd public && python3 -m http.server 8080
```
Abrir http://localhost:8080. Sem `config.js` preenchido, roda em modo demonstração:
produtor João (97) 98888-1111; comprador Carlos (97) 90000-0009, senha `boi123`.

## Login sem senha: como funciona

O produtor entra só com o telefone (decisão do Ronaldo, 24/11/2026). Por baixo, a conta no Supabase usa
`<telefone>@tel.rededoboi.app` e uma senha derivada do telefone + `chaveApp`. Quem souber o telefone de alguém
consegue entrar na conta dele; por isso administradores criam uma senha própria e só eles veem os dados de todos.
Para trocar por código SMS no futuro, basta ligar o provedor de SMS no Supabase e trocar a função `entrar` em `js/api.js`.

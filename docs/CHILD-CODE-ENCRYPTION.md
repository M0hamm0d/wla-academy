# Child access-code encryption (D-143)

The same key also encrypts each purchaser's viewable copy of a gift code (D-149), bound to the gift rather than to a child. `scripts/rotate-child-code-key.ts` re-seals both kinds of copy. If the key is lost, a purchaser chooses "Get a new code", which replaces the gift's code.

A parent can view their child's active access code. Sign-in doesn't use this: it
verifies the bcrypt hash and the keyed lookup in the database, exactly as before.

## What is stored

| Column | What it is | Used for |
|---|---|---|
| `code_hash` | bcrypt | Sign-in |
| `code_lookup` | HMAC with a pepper held in the database | Sign-in |
| `code_ciphertext` | AES-256-GCM, made by the application server | Showing the code to its parent |

- The plaintext is never stored.
- The ciphertext is bound to the child and the credential, so a copy moved to
  another row won't decrypt.
- No client role can read it: it is outside the column grant, and
  `store_child_code_copy` and `read_child_code_copy` are service-role only. Both
  re-check the parent. Administrators have no way to see a code.
- Revoking a code clears its copy (database trigger).

**The risk accepted:** anyone holding both the database and the key can read active
codes. A code only opens one child's missions, and a parent can already replace it.

## Secrets

| Variable | Purpose |
|---|---|
| `CHILD_CODE_ENCRYPTION_KEY` | The current key: 32 random bytes, base64 |
| `CHILD_CODE_ENCRYPTION_KEY_PREVIOUS` | The old key, only during a rotation |

Rules: server-side only (never `NEXT_PUBLIC_`), never in the database or Git, and
different in every environment.

Create one with:

```
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Put it in the hosting provider's secret settings. Locally it belongs in
`.env.development.local`, which Git ignores. Keep a copy of the production key in
the team's secret store.

## Rotating the key

1. Generate a new key.
2. Set `CHILD_CODE_ENCRYPTION_KEY` to the new key and
   `CHILD_CODE_ENCRYPTION_KEY_PREVIOUS` to the old one, then redeploy. Existing
   copies keep opening, and new ones use the new key.
3. Run the script with those two values plus the service-role settings:

   ```
   node scripts/rotate-child-code-key.ts
   ```

   It prints counts only and can be run again. It must finish with `unreadable: 0`
   and `failed: 0`.
4. Remove `CHILD_CODE_ENCRYPTION_KEY_PREVIOUS` and redeploy.

## If the key is lost or stolen

**Lost:** every code keeps working, because sign-in doesn't use the key. Parents see
"We can't show this code right now" and can replace the code. Set a new key; replaced
codes become viewable. Copies under the lost key can't be recovered.

**Stolen:** rotate the key as above. If the database may also have been taken, treat
active codes as exposed and have them replaced, which also signs those children out.
Don't bulk-replace without telling parents, because their children will need the new
code.

## Codes made before this feature

They keep working and have no copy. The profile says "Replace this code to be able
to view it." The migration deliberately replaces nothing.

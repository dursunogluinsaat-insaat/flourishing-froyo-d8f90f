# Emlak CRM Cloud Sync kurulumu

## 1. MongoDB Atlas

MongoDB Atlas’ta bir veritabanı kullanıcısı oluşturun ve bu kullanıcıya CRM veritabanı için read/write yetkisi verin. Vercel Serverless Function’ın Atlas’a erişebilmesi için Network Access bölümünde uygun Vercel çıkış erişimini tanımlayın. Geliştirme sırasında gerekirse geçici olarak `0.0.0.0/0` kullanılabilir; üretimde daha kısıtlı bir kural tercih edilmelidir.

Parolada `@`, `#`, `%` veya `:` gibi karakterler varsa MongoDB URI içinde URL-encode edin.

## 2. Vercel Production değişkenleri

Vercel Project Settings → Environment Variables bölümüne Production ortamı için aşağıdakileri ekleyin:

```text
MONGODB_URI=mongodb+srv://...
MONGODB_DB=emlak_crm
CRM_SESSION_SECRET=<uzun-rastgele-gizli-değer>
CRM_ADMIN_PASSWORD=<güçlü-admin-parolası>
CRM_ADMIN_EMAIL=admin@example.com
CRM_ADMIN_FIRST_NAME=Yönetici
CRM_ADMIN_LAST_NAME=Admin
```

Gerçek sırları GitHub’a, frontend’e veya sohbet mesajına koymayın.

## 3. İlk açılış

İlk cihazda eski `crm_members_v2` kaydı varsa frontend, başarılı health kontrolünden sonra üyeleri bir defaya mahsus backend’e hash’lenmiş parola olarak taşır. Sonrasında admin kullanıcı ile giriş yaparak ortak CRM state’i oluşturur. Migration tamamlandıktan sonra eski cihazdaki CRM localStorage anahtarları kaldırılır.

Eski cihazda üye kaydı yoksa backend, yalnızca `CRM_ADMIN_PASSWORD` tanımlıysa ilk `admin` hesabını oluşturur. Bu hesapla giriş yapılabilir.

## 4. API doğrulama

Deploy sonrasında şu endpoint kontrol edilmelidir:

```text
GET /api/crm?resource=health
```

Başarılı yanıt:

```json
{"ok":true,"service":"crm","database":"connected"}
```

`503` yanıtı alınırsa `MONGODB_URI`, URI parola encoding’i, Atlas Network Access ve Vercel Production environment değişkenlerinin deploy sonrasında etkinleştiğini kontrol edin.

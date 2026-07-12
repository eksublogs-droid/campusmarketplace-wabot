const productRepo = require('../repos/productRepo');

async function demoteExpiredProPlans() {
  await productRepo.demoteExpiredPro();
}

async function deleteOldSoldProducts() {
  await productRepo.deleteOldSold();
}

async function checkExpiringProPlans(sock, adminWhatsappId) {
  const expiring = await productRepo.getSoonExpiringPro();
  for (const p of expiring) {
    await sock.sendMessage(adminWhatsappId, {
      text: `⏰ Pro listing expiring soon:\n📦 ${p.name}\nExpires: ${new Date(p.premium_expires_at).toLocaleString('en-NG')}`
    }).catch(() => {});
  }
}

module.exports = { demoteExpiredProPlans, deleteOldSoldProducts, checkExpiringProPlans };

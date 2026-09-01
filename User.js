const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  telegramId: { type: String, required: true, unique: true },
  firstName: { type: String, required: true },
  lastName: { type: String, default: '' },
  username: { type: String, default: '' },
  photoUrl: { type: String, default: '' },

  // Coins & Balances
  mainCoins: { type: Number, default: 0 },
  dailyCoins: { type: Number, default: 0 },
  bonusBalanceUSD: { type: Number, default: 0.0 },

  // Referral System
  referredBy: { type: String, default: null },
  referralCount: { type: Number, default: 0 },
  referrals: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

  // Counters
  adsWatched: { type: Number, default: 0 },
  gamesPlayedForReferral: { type: Number, default: 0 }, // 👈 গেম খেলার কাউন্টার
  referralBonusGiven: { type: Boolean, default: false },
  country: { type: String, default: 'Unknown' },
  isVpn: { type: Boolean, default: false },

  // 🟢 Monetag Polling System (এই ২টা লাইন যোগ করবেন)
  pendingSubId: { type: String, default: '' },
  lastVerifiedSubId: { type: String, default: '' },

  createdAt: { type: Date, default: Date.now }
});

userSchema.index({ dailyCoins: -1 });

module.exports = mongoose.model('User', userSchema);

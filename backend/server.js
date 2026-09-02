const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const cron = require('node-cron');
const axios = require('axios');
const { Telegraf } = require('telegraf'); 
const crypto = require('crypto');
require('dotenv').config();

const admin = require('firebase-admin');
admin.initializeApp({
  credential: admin.credential.applicationDefault()
});

const authRoutes = require('./routes/auth');
const User = require('./models/User'); 

const app = express();

app.use(cors({ origin: '*' }));
app.set('trust proxy', true);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.get('/', (req, res) => {
  res.status(200).send('Server is alive and running!');
});

app.get('/ping', (req, res) => {
  res.status(200).send('Pong');
});

// ============ MATCH SCHEMA ============
const matchSchema = new mongoose.Schema({
  mode: { type: Number, enum: [2, 4], required: true },
  entryFeeCoins: { type: Number, default: 250 },
  status: { type: String, enum: ['pending', 'completed'], default: 'pending' },
  players: [{
    userId: String,
    firstName: String,
    hits: { type: Number, default: 0 },
    timeTaken: { type: Number, default: 0 },
    finishedAt: Date,
    prizeUSD: { type: Number, default: 0 }
  }],
  createdAt: { type: Date, default: Date.now }
});

const Match = mongoose.models.Match || mongoose.model('Match', matchSchema);

// ============ TELEGRAM BOT SETUP ============
const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE';
const WEB_APP_URL = process.env.WEB_APP_URL || 'https://your-vercel-app.vercel.app';
const CHANNEL_URL = process.env.CHANNEL_URL || 'https://t.me/your_official_channel';
const GROUP_URL = process.env.GROUP_URL || 'https://t.me/your_official_group';
const EXTRA_CHANNEL_URL = process.env.EXTRA_CHANNEL_URL || '';

const bot = new Telegraf(BOT_TOKEN);

const getUsername = (urlOrUsername) => {
  if (!urlOrUsername) return null;
  if (urlOrUsername.startsWith('@')) return urlOrUsername;
  const parts = urlOrUsername.split('/');
  const lastPart = parts[parts.length - 1];
  return lastPart ? `@${lastPart}` : null;
};

if (process.env.BOT_TOKEN) {
  const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://play-for-earns.onrender.com/telegram-webhook';
  bot.telegram.setWebhook(WEBHOOK_URL)
    .then(() => console.log('✅ Webhook Configured Successfully'))
    .catch((err) => console.error('Webhook Error:', err.message));

  app.use(bot.webhookCallback('/telegram-webhook'));
}

app.use('/api/auth', authRoutes);

// Helper function: Client IP & Country Detection (With 3s Timeout)
const getClientIpAndCountry = async (req, frontendIp) => {
  let clientIp = frontendIp || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  if (clientIp && clientIp.includes(',')) {
    clientIp = clientIp.split(',')[0].trim();
  }

  if (clientIp === '::1' || clientIp === '127.0.0.1' || !clientIp) {
    return { clientIp: '', countryName: 'Unknown', isVpnOrProxy: false };
  }

  try {
    const ipResponse = await axios.get(`http://ip-api.com/json/${clientIp}?fields=status,country,proxy,hosting`, { timeout: 3000 });
    if (ipResponse.data.status === 'success') {
      return {
        clientIp,
        countryName: ipResponse.data.country_name || 'Unknown',
        isVpnOrProxy: Boolean(ipResponse.data.proxy || ipResponse.data.hosting)
      };
    }
  } catch (err) {
    console.error("IP Check Error:", err.message);
  }

  return { clientIp, countryName: 'Unknown', isVpnOrProxy: false };
};


// 🟢 ঠিক এই জায়গায় processMatchCompletion ফাংশনটি বসান
const processMatchCompletion = async (matchId, userId, score, timeTaken) => {
  let match = await Match.findById(matchId);
  if (!match) throw new Error('Match not found');

  const playerIndex = match.players.findIndex(p => String(p.userId) === String(userId));
  
  if (playerIndex !== -1) {
    match.players[playerIndex].hits = Number(score) || 0;
    match.players[playerIndex].timeTaken = Number(timeTaken) || 0;
    match.players[playerIndex].finishedAt = new Date();
  } else {
    match.players.push({
      userId: String(userId),
      hits: Number(score) || 0,
      timeTaken: Number(timeTaken) || 0,
      finishedAt: new Date()
    });
  }

  const isFull = match.players.length >= match.mode;
  const allFinished = isFull && match.players.every(p => p.finishedAt);

  if (allFinished) {
    match.status = 'completed';

    // স্কোর ও সময় অনুযায়ী র‍্যাঙ্ক নির্ধারণ
    match.players.sort((a, b) => {
      if (b.hits !== a.hits) return b.hits - a.hits;
      return (a.timeTaken || 0) - (b.timeTaken || 0);
    });

    // প্রাইজ বণ্টন
    if (match.mode === 2) {
      if (match.players[0]) match.players[0].prizeUSD = 0.10;
      if (match.players[1]) match.players[1].prizeUSD = 0.00;
    } else if (match.mode === 4) {
      if (match.players[0]) match.players[0].prizeUSD = 0.10;
      if (match.players[1]) match.players[1].prizeUSD = 0.07;
      if (match.players[2]) match.players[2].prizeUSD = 0.03;
      if (match.players[3]) match.players[3].prizeUSD = 0.00;
    }

    // বিজয়ী প্লেয়ারদের অ্যাকাউন্টে বোনাস ডলার যোগ
    for (const p of match.players) {
      if (p.prizeUSD > 0) {
        await User.findOneAndUpdate(
          { userId: p.userId },
          { $inc: { bonusBalanceUSD: p.prizeUSD } }
        );
      }
    }
  }

  await match.save();
  return match;
};

// Deduct Coins API (Updated for double spend prevention)
app.post('/api/user/deduct-coins', async (req, res) => {
  try {
    const { userId, amount } = req.body;
    const deductAmount = Number(amount);

    if (!userId || isNaN(deductAmount) || deductAmount <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid payload' });
    }

    // 🔴 আপডেট: findOneAndUpdate ব্যবহার করে ব্যালেন্স পর্যাপ্ত থাকলে তবেই কাটা
    const updatedUser = await User.findOneAndUpdate(
      { userId, mainCoins: { $gte: deductAmount } },
      { $inc: { mainCoins: -deductAmount } },
      { new: true }
    );

    if (!updatedUser) {
      return res.status(400).json({ success: false, message: 'Insufficient balance or user not found' });
    }

    res.json({ success: true, remainingCoins: updatedUser.mainCoins });
  } catch (err) {
    console.error('Deduct coins error:', err);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
});

// Match Join API (Updated with Atomic Operations)
app.post('/api/match/join', async (req, res) => {
  try {
    const { userId, firstName, mode } = req.body;

    if (!userId) {
      return res.status(400).json({ success: false, error: "Google User is required" });
    }

    const matchMode = Number(mode) || 2;
    const playeruserId = String(userId);
    const entryFee = 250;

    const userPendingCount = await Match.countDocuments({
      status: 'pending',
      'players.userId': playeruserId
    });

    if (userPendingCount >= 3) {
      return res.status(400).json({
        success: false,
        error: "You are already in 3 pending matches. Please wait for them to complete!"
      });
    }

    // 🔴 আপডেট: পারমাণবিক উপায়ে (Atomic) ব্যালেন্স চেক ও কাটা
    const user = await User.findOneAndUpdate(
      { userId: playeruserId, mainCoins: { $gte: entryFee } },
      { $inc: { mainCoins: -entryFee } },
      { new: true }
    );

    if (!user) {
      return res.status(400).json({ success: false, error: "Insufficient coins! 250 Coins required." });
    }

    // 🔴 আপডেট: পারমাণবিক উপায়ে (Atomic) প্লেয়ার লিস্টে যুক্ত করা (রুম ফুল হওয়া ঠেকাতে)
    let match = await Match.findOneAndUpdate(
      {
        status: 'pending',
        mode: matchMode,
        $expr: { $lt: [{ $size: "$players" }, matchMode] },
        'players.userId': { $ne: playeruserId }
      },
      {
        $push: { players: { userId: playeruserId, firstName: firstName || 'Player', hits: 0, timeTaken: 0 } }
      },
      { new: true }
    );

    if (!match) {
      match = new Match({
        mode: matchMode,
        entryFeeCoins: entryFee,
        status: 'pending',
        players: [{ userId: playeruserId, firstName: firstName || 'Player', hits: 0, timeTaken: 0 }]
      });
      await match.save();
    }

    return res.status(200).json({ 
      success: true, 
      matchId: match._id,
      remainingCoins: user.mainCoins
    });

  } catch (err) {
    console.error("Match join error:", err);
    return res.status(500).json({ 
      success: false, 
      error: "Server internal error!" 
    });
  }
});

// Score Submit / Finish API (Updated)
app.post(['/api/match/submit-score', '/api/match/finish'], async (req, res) => {
  try {
    const { matchId, userId, hits, score, timeTaken } = req.body;
    const finalScore = hits !== undefined ? hits : score;

    if (!matchId || !userId) {
      return res.status(400).json({ success: false, message: 'matchId and google User required' });
    }

    // হেলপার ফাংশনটিকে কল করা হচ্ছে
    const match = await processMatchCompletion(matchId, userId, finalScore, timeTaken);
    res.json({ success: true, match });
  } catch (err) {
    console.error('Submit Score Error:', err);
    res.status(500).json({ success: false, error: err.message || 'Server error' });
  }
});

// ৪. লাস্ট ৫টি ম্যাচের হিস্ট্রি
app.get('/api/match/history/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const history = await Match.find({ 'players.userId': String(userId) })
      .sort({ createdAt: -1 }) // নতুন ম্যাচ সবার ওপরে দেখাবে
      .limit(5)          // সবসময় লেটেস্ট ৫টি ম্যাচ ফিল্টার করবে
      .lean();
    const formattedHistory = history.map(m => {
      const matchObj = m;

      // ১. প্লেয়ারদের হিট (hits) এবং টাইম (timeTaken) অনুযায়ী র‍্যাঙ্ক সাজানো
      matchObj.players.sort((a, b) => {
        const hitsA = a.hits || 0;
        const hitsB = b.hits || 0;
        if (hitsB !== hitsA) return hitsB - hitsA;
        return (a.timeTaken || 0) - (b.timeTaken || 0);
      });

      // ২. ইউজারের বর্তমান র‍্যাঙ্ক ইনডেক্স খুঁজে বের করা
      const userRankIndex = matchObj.players.findIndex(
        p => String(p.userId) === String(userId)
      );

      // ৩. মোড ও র‍্যাঙ্ক অনুযায়ী প্রাইস সেট করা
      let potentialPrize = 0.00;
      if (matchObj.mode === 2) {
        potentialPrize = userRankIndex === 0 ? 0.10 : 0.00;
      } else if (matchObj.mode === 4) {
        if (userRankIndex === 0) potentialPrize = 0.10;
        else if (userRankIndex === 1) potentialPrize = 0.07;
        else if (userRankIndex === 2) potentialPrize = 0.03;
        else potentialPrize = 0.00;
      }

      // ৪. পেন্ডিং থাকা অবস্থায় সম্ভাব্য প্রাইজ যুক্ত করা
      matchObj.players = matchObj.players.map(p => {
        if (m.status === 'pending' && String(p.userId) === String(userId)) {
          return {
            ...p,
            prizeUSD: p.prizeUSD > 0 ? p.prizeUSD : potentialPrize
          };
        }
        return p;
      });

      return matchObj;
    });

    res.json(formattedHistory);
  } catch (err) {
    console.error('Match History Error:', err);
    res.status(500).json({ error: 'Server error fetching history' });
  }
});

// ==================== API ENDPOINTS FOR USER & SYNC ====================

app.post('/api/save-user-location', async (req, res) => {
  try {
    const { userId, clientIp: frontendIp } = req.body;
    if (!userId) return res.status(400).json({ error: 'User ID required' });

    const { countryName, isVpnOrProxy } = await getClientIpAndCountry(req, frontendIp);

    await User.findOneAndUpdate(
      { userId: String(userId) },
      { 
        country: countryName, 
        isVpn: isVpnOrProxy, 
        lastLogin: Date.now() 
      },
      { upsert: true, new: true }
    );

    res.json({ success: true, country: countryName, isVpn: isVpnOrProxy });
  } catch (err) {
    console.error("Save Location Error:", err);
    res.status(500).json({ error: 'Server error saving location' });
  }
});

app.post('/api/user/sync', async (req, res) => {
  // 🟢 userId এবং idToken দুটোই রিসিভ করা হলো, যাতে আগের কোড ভাঙ না যায়
  const { idToken, userId, firstName, username, photoUrl, referrerId, clientIp: frontendIp } = req.body;

  if (!userId || !idToken) {
    return res.status(400).json({ error: 'User ID and Firebase ID Token are required' });
  }

  try {
    // ফায়ারবেস টোকেন ভেরিফাই করে নিশ্চিত হওয়া যে ইউজার বৈধ
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    if (decodedToken.uid !== String(userId)) {
      return res.status(403).json({ error: 'Unauthorized user mismatch!' });
    }
    const { countryName, isVpnOrProxy } = await getClientIpAndCountry(req, frontendIp);

    let user = await User.findOne({ userId: String(userId) }).populate('referrals', 'firstName username photoUrl gamesPlayedForReferral');

    if (!user) {
      user = new User({
        userId: String(userId),
        firstName: firstName || 'User',
        username: username || '',
        photoUrl: photoUrl || '',
        referredBy: referrerId || null,
        country: countryName,
        isVpn: isVpnOrProxy
      });
      await user.save();

      if (referrerId && String(referrerId) !== String(userId)) {
        await User.findOneAndUpdate(
          { userId: String(referrerId) },
          {
            $inc: { referralCount: 1 },
            $push: { referrals: user._id }
          }
        );
      }
    } else {
      user.firstName = firstName || user.firstName;
      user.username = username || user.username;
      user.photoUrl = photoUrl || user.photoUrl;
      user.country = countryName !== 'Unknown' ? countryName : user.country;
      user.isVpn = isVpnOrProxy;
      await user.save();
    }

    const tier1Countries = ['United States', 'United Kingdom', 'Canada', 'Australia', 'Germany', 'France', 'Switzerland', 'Norway', 'Sweden', 'Denmark', 'Netherlands'];
    const tier2Countries = ['United Arab Emirates', 'Saudi Arabia', 'Qatar', 'Kuwait', 'Singapore', 'Japan', 'South Korea', 'Malaysia', 'Spain', 'Italy', 'Brazil', 'Mexico'];

    let coinsPerDollar = 140000;
    if (tier1Countries.includes(user.country)) {
      coinsPerDollar = 100000;
    } else if (tier2Countries.includes(user.country)) {
      coinsPerDollar = 130000;
    }

    const userResponse = {
      ...user.toObject(),
      coinsPerDollar: coinsPerDollar
    };

    res.json(userResponse);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// রেফারেল কোড লিঙ্ক এবং বন্ধুর অ্যাকাউন্টে তথ্য সেভ করার API
app.post('/api/user/apply-referral', async (req, res) => {
  try {
    const { userId, referralCode } = req.body;

    if (!userId || !referralCode) {
      return res.status(400).json({ success: false, message: 'User ID and Referral Code are required' });
    }

    // নিজের কোড নিজে ব্যবহার করা আটকানোর জন্য
    if (String(userId) === String(referralCode)) {
      return res.status(400).json({ success: false, message: "You can't use your own referral code!" });
    }

    // বর্তমান ইউজারকে খুঁজে বের করা
    let currentUser = await User.findOne({ userId: String(userId) });
    if (!currentUser) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // যদি ইউজার ইতিমধ্যে কারো রেফারেল ব্যবহার করে থাকে
    if (currentUser.referredBy) {
      return res.status(400).json({ success: false, message: 'Referral code already applied!' });
    }

    // যে বন্ধু রেফার করেছে (Referrer) তাকে খুঁজে বের করা
    let referrerUser = await User.findOne({ userId: String(referralCode) });
    if (!referrerUser) {
      return res.status(404).json({ success: false, message: 'Invalid Referral Code! Referrer not found.' });
    }

    // ১. বর্তমান ইউজারের `referredBy` আপডেট করা
    currentUser.referredBy = String(referralCode);
    await currentUser.save();

    // ২. বন্ধুর (Referrer) অ্যাকাউন্টে ইউজারের তথ্য সেভ করা
    const alreadyExists = referrerUser.referrals.includes(currentUser._id);
    if (!alreadyExists) {
      referrerUser.referralCount = (referrerUser.referralCount || 0) + 1;
      referrerUser.referrals.push(currentUser._id); // রেফারের অ্যারেতে ইউজারের অবজেক্ট আইডি যুক্ত হলো
      await referrerUser.save();
    }

    return res.status(200).json({
      success: true,
      message: 'Referral code linked successfully!',
      referredBy: currentUser.referredBy
    });

    } catch (err) {
      console.error('Apply referral error:', err);
      return res.status(500).json({ success: false, message: 'Server error' });
    }
});

// ==================== UNITY LEVELPLAY AD REWARD API ====================
// অ্যান্ড্রয়েড অ্যাপে Unity LevelPlay থেকে রিওয়ার্ড পাওয়ার পর এই এন্ডপয়েন্টে কল করা হবে
app.post('/api/user/ad-reward', async (req, res) => {
  const { userId } = req.body;

  if (!userId) {
    return res.status(400).json({ success: false, message: 'User ID is required' });
  }

  try {
    const user = await User.findOneAndUpdate(
      { userId: String(userId) },
      { 
        $inc: { 
          mainCoins: 80, 
          dailyCoins: 80,
          adsWatched: 1 
        } 
      },
      { new: true }
    );

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    return res.status(200).json({
      success: true,
      message: '80 coins added successfully',
      mainCoins: user.mainCoins,
      dailyCoins: user.dailyCoins
    });
  } catch (error) {
    console.error('Unity Ad reward error:', error);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

// ৫. রিওয়ার্ড ক্লেইম (Anti-Cheat Security)
app.post('/api/game/reward', async (req, res) => {
  try {
    const { userId, coins } = req.body;
    const rewardCoins = Number(coins);

    if (!userId || isNaN(rewardCoins) || rewardCoins <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid payload' });
    }

    const MAX_ALLOWED_COINS = 300; 
    if (rewardCoins > MAX_ALLOWED_COINS) {
      console.warn(`🚨 Anti-Cheat Triggered for User: ${userId}. Attempted coins: ${rewardCoins}`);
      return res.status(403).json({ success: false, message: 'Cheating detected! Reward denied.' });
    }

    let user = await User.findOne({ userId: String(userId) });
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    user.mainCoins = (user.mainCoins || 0) + rewardCoins;
    user.dailyCoins = (user.dailyCoins || 0) + rewardCoins;
    user.gamesPlayedForReferral = (user.gamesPlayedForReferral || 0) + 1;

    if (user.referredBy && user.gamesPlayedForReferral >= 10 && !user.referralBonusGiven) {
      await User.findOneAndUpdate(
        { userId: String(user.referredBy) },
        {
          $inc: {
            mainCoins: 1000,
            dailyCoins: 1000
          }
        }
      );
      user.referralBonusGiven = true;
    }

    await user.save();

    res.json({
      success: true,
      message: 'Coins claimed successfully',
      mainCoins: user.mainCoins,
      dailyCoins: user.dailyCoins,
      gamesPlayedForReferral: user.gamesPlayedForReferral
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ডেইলি টাইমার এন্ডপয়েন্ট
app.get('/api/contest/timer', (req, res) => {
  const now = new Date();
  const bdNowStr = now.toLocaleString("en-US", { timeZone: "Asia/Dhaka" });
  const bdNow = new Date(bdNowStr);

  const bdEndOfDay = new Date(bdNowStr);
  bdEndOfDay.setHours(23, 59, 59, 999);

  const difference = bdEndOfDay - bdNow;

  if (difference <= 0) {
    return res.json({ hours: 0, minutes: 0, seconds: 0 });
  }

  res.json({
    hours: Math.floor((difference / (1000 * 60 * 60)) % 24),
    minutes: Math.floor((difference / 1000 / 60) % 60),
    seconds: Math.floor((difference / 1000) % 60),
  });
});


// 3-TIER DYNAMIC WITHDRAW API
app.post('/api/user/withdraw', async (req, res) => {
  try {
    const { userId, wallet, amount } = req.body;

    const user = await User.findOne({ userId: String(userId) });
    if (!user) {
      return res.status(404).json({ error: 'User not found!' });
    }

    const { countryName, isVpnOrProxy } = await getClientIpAndCountry(req);
    if (isVpnOrProxy) {
      return res.status(403).json({ error: '❌ VPN or Proxy detected! Please disable your VPN to withdraw.' });
    }

    if (countryName !== 'Unknown') {
      user.country = countryName;
    }

    const reqAmount = parseFloat(amount);
    if (isNaN(reqAmount) || reqAmount <= 0) {
      return res.status(400).json({ error: 'Invalid amount entered!' });
    }

    const userBonus = user.bonusBalanceUSD || 0;
    if (userBonus < reqAmount) {
      return res.status(400).json({ error: 'Insufficient Bonus Balance!' });
    }

    const tier1Countries = [
      'United States', 'United Kingdom', 'Canada', 'Australia', 
      'Germany', 'France', 'Switzerland', 'Norway', 'Sweden', 'Denmark', 'Netherlands'
    ];

    const tier2Countries = [
      'United Arab Emirates', 'Saudi Arabia', 'Qatar', 'Kuwait', 
      'Singapore', 'Japan', 'South Korea', 'Malaysia', 'Spain', 'Italy', 'Brazil', 'Mexico'
    ];

    let coinsPerDollar = 140000;
    let userTier = "Tier 3";

    if (tier1Countries.includes(user.country)) {
      coinsPerDollar = 100000;
      userTier = "Tier 1";
    } else if (tier2Countries.includes(user.country)) {
      coinsPerDollar = 130000;
      userTier = "Tier 2";
    }

    const requiredCoins = reqAmount * coinsPerDollar;

    if ((user.mainCoins || 0) < requiredCoins) {
      return res.status(400).json({
        error: `Insufficient Main Coins! For your country (${user.country || 'Unknown'} - ${userTier}), required: ${requiredCoins.toLocaleString()} Coins for $${reqAmount}.`
      });
    }

    user.bonusBalanceUSD = parseFloat((userBonus - reqAmount).toFixed(2));
    user.mainCoins -= requiredCoins;
    await user.save();

    try {
      const adminMessage = 
        `🚨<b>New Withdraw Request!</b>🚨\n\n` +
        `👤<b>User:</b> ${user.firstName || 'User'} (${user.email || user.username || 'N/A'})\n` +
        `🌍<b>Country:</b> ${user.country || 'Unknown'} (${userTier})\n` +
        `🆔<b>userId:</b> <code>${user.userId}</code>\n` +
        `💵<b>Withdraw Amount:</b> $${reqAmount}\n` +
        `🔥<b>Coins Fee Deducted:</b> ${requiredCoins.toLocaleString()} (${coinsPerDollar.toLocaleString()}/$)\n` +
        `💎<b>TON Wallet:</b> <code>${wallet}</code>`;

      const adminChatId = process.env.ADMIN_CHAT_ID;
      if (adminChatId) {
        await bot.telegram.sendMessage(adminChatId, adminMessage, { parse_mode: 'HTML' });
      }
    } catch (telegramErr) {
      console.error('Telegram Notification Error:', telegramErr.message);
    }

    return res.json({ success: true, message: 'Withdraw request submitted successfully!' });

  } catch (error) {
    console.error('Withdraw API Error:', error);
    return res.status(500).json({ error: 'Something went wrong. Try again!' });
  }
});

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI)
  .then(async () => {
    console.log('✅ MongoDB Connected Successfully');
    
    // ইনডেক্স নিরাপদভাবে তৈরি করার ট্রাই-ক্যাচ ব্লক
    try {
      await User.collection.createIndex({ userId: 1 }, { unique: true });
    } catch (e) {
      // আগে থেকে ইনডেক্স থাকলে এরর স্কিপ করবে
    }

    try {
      await User.collection.createIndex({ dailyCoins: -1 });
    } catch (e) {}

    try {
      await Match.collection.createIndex({ status: 1, mode: 1 });
    } catch (e) {}

    console.log('⚡ Database Indexes Verified/Ready');
  })
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

// ==================== DAILY CONTEST RESET LOGIC ====================
const executeDailyContestReset = async () => {
  // 🛑 বোনাস দেওয়া পুরোপুরি বন্ধ রাখতে এই ৩ লাইন যোগ করুন:
  console.log('⚠️ Contest is OFF. Reset & bonus distribution skipped.');
  return false;

  /* 🟢 আপনার আসল প্রাইজ দেওয়ার কোড নিচে নিরাপদেই রইলো */
  console.log('🏆 Running Daily Contest Reset & Distributing Prizes...');
  try {
    const topUsers = await User.find({ dailyCoins: { $gt: 0 } }).sort({ dailyCoins: -1 }).limit(10).lean();
    const prizes = [1, 0.80, 0.50, 0.30, 0.20, 0.10, 0.10, 0.10, 0.10, 0.10];

    for (let i = 0; i < topUsers.length; i++) {
      if (topUsers[i] && topUsers[i].dailyCoins > 0) {
        await User.findByIdAndUpdate(topUsers[i]._id, {
          $inc: { bonusBalanceUSD: prizes[i] }
        });
        console.log(`Prize $${prizes[i]} sent to User: ${topUsers[i].firstName || topUsers[i].username}`);
      }
    }

    await User.updateMany({ dailyCoins: { $gt: 0 } }, { $set: { dailyCoins: 0 } });
    console.log('✅ Daily Contest Reset Successfully!');
    return true;
  } catch (error) {
    console.error('❌ Reset Error:', error);
    return false;
  }
};

// Cron schedule (Midnight Asia/Dhaka)
cron.schedule('0 0 * * *', executeDailyContestReset, {
  scheduled: true,
  timezone: "Asia/Dhaka"
});

// (Optional) Manual Trigger for Admin Testing
app.post('/api/admin/reset-daily-contest', async (req, res) => {
  const { adminSecret } = req.body;
  if (adminSecret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  const result = await executeDailyContestReset();
  if (result) res.json({ success: true, message: 'Contest reset manually.' });
  else res.status(500).json({ success: false, error: 'Reset failed.' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

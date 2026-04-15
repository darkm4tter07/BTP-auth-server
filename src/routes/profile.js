import { Router } from 'express';
import prisma from '../lib/prisma.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';

const router = Router();

// ------------------------------------------------------------------
// HELPER — calculate cognitive result from score
// ------------------------------------------------------------------
function getCognitiveResult(score) {
  if (score >= 70) return 'FIT';
  if (score >= 50) return 'SUPERVISION_REQUIRED';
  return 'UNFIT';
}

// ------------------------------------------------------------------
// WORKER PROFILE ROUTES
// ------------------------------------------------------------------

// GET /profile/:userId — get full profile (admin or own)
router.get('/:userId', requireAuth, async (req, res) => {
  try {
    const { userId } = req.params;

    // Workers can only view their own profile
    if (req.user.role !== 'ADMIN' && req.user.sub !== userId) {
      return res.status(403).json({ detail: 'Access denied' });
    }

    const user = await prisma.users.findUnique({
      where: { id: userId },
      include: { worker_profiles: true },
    });

    if (!user) return res.status(404).json({ detail: 'User not found' });

    res.json({
      id: user.id,
      email: user.email,
      full_name: user.full_name,
      role: user.role,
      employee_id: user.employee_id,
      phone_number: user.phone_number,
      profile_picture: user.profile_picture,
      is_active: user.is_active,
      created_at: user.created_at,
      profile: user.worker_profiles || null,
    });
  } catch (err) {
    res.status(500).json({ detail: err.message });
  }
});

// POST /profile/:userId — create profile (admin or own)
router.post('/:userId', requireAuth, async (req, res) => {
  try {
    const { userId } = req.params;

    if (req.user.role !== 'ADMIN' && req.user.sub !== userId) {
      return res.status(403).json({ detail: 'Access denied' });
    }

    // Check if profile already exists
    const existing = await prisma.worker_profiles.findUnique({
      where: { user_id: userId },
    });
    if (existing) {
      return res.status(400).json({ detail: 'Profile already exists. Use PUT to update.' });
    }

    const {
      gender, age, height_cm, weight_kg, blood_group, dominant_hand,
      identification_mark, profile_photo_url, major_illness, disability,
      known_allergies, medications, last_medical_checkup,
      designation, experience_years, zone_assignment, certifications, date_joined,
      emergency_contact_name, emergency_contact_phone, emergency_contact_relation,
    } = req.body;

    // Only admin can set fitness_status
    const fitness_status = req.user.role === 'ADMIN'
      ? (req.body.fitness_status || 'PENDING')
      : 'PENDING';

    const profile = await prisma.worker_profiles.create({
      data: {
        id: crypto.randomUUID(),
        user_id: userId,
        gender, age, height_cm, weight_kg, blood_group, dominant_hand,
        identification_mark, profile_photo_url, major_illness, disability,
        known_allergies, medications,
        last_medical_checkup: last_medical_checkup ? new Date(last_medical_checkup) : null,
        fitness_status,
        designation, experience_years, zone_assignment,
        certifications: certifications || [],
        date_joined: date_joined ? new Date(date_joined) : null,
        emergency_contact_name, emergency_contact_phone, emergency_contact_relation,
      },
    });

    res.status(201).json(profile);
  } catch (err) {
    res.status(500).json({ detail: err.message });
  }
});

// PUT /profile/:userId — update profile (admin or own, with restrictions)
router.put('/:userId', requireAuth, async (req, res) => {
  try {
    const { userId } = req.params;

    if (req.user.role !== 'ADMIN' && req.user.sub !== userId) {
      return res.status(403).json({ detail: 'Access denied' });
    }

    const {
      gender, age, height_cm, weight_kg, blood_group, dominant_hand,
      identification_mark, profile_photo_url, major_illness, disability,
      known_allergies, medications, last_medical_checkup,
      designation, experience_years, zone_assignment, certifications, date_joined,
      emergency_contact_name, emergency_contact_phone, emergency_contact_relation,
    } = req.body;

    // Build update data
    const updateData = {
      gender, age, height_cm, weight_kg, blood_group, dominant_hand,
      identification_mark, profile_photo_url, major_illness, disability,
      known_allergies, medications,
      last_medical_checkup: last_medical_checkup ? new Date(last_medical_checkup) : undefined,
      designation, experience_years, zone_assignment,
      certifications: certifications || undefined,
      date_joined: date_joined ? new Date(date_joined) : undefined,
      emergency_contact_name, emergency_contact_phone, emergency_contact_relation,
      updated_at: new Date(),
    };

    // Only admin can update these fields
    if (req.user.role === 'ADMIN') {
      updateData.fitness_status = req.body.fitness_status || undefined;
      updateData.zone_assignment = req.body.zone_assignment || undefined;
    }

    // Remove undefined fields
    Object.keys(updateData).forEach(k => updateData[k] === undefined && delete updateData[k]);

    const profile = await prisma.worker_profiles.upsert({
      where: { user_id: userId },
      update: updateData,
      create: {
        id: crypto.randomUUID(),
        user_id: userId,
        fitness_status: 'PENDING',
        ...updateData,
      },
    });

    res.json(profile);
  } catch (err) {
    res.status(500).json({ detail: err.message });
  }
});

// GET /profile/:userId/photo-url — get Supabase upload URL hint
// Frontend uploads directly to Supabase, this just returns the expected path
router.get('/:userId/photo-url', requireAuth, async (req, res) => {
  const { userId } = req.params;
  if (req.user.role !== 'ADMIN' && req.user.sub !== userId) {
    return res.status(403).json({ detail: 'Access denied' });
  }
  res.json({
    upload_path: `worker-profiles/${userId}/profile.jpg`,
    bucket: 'worker-profiles',
  });
});

// ------------------------------------------------------------------
// COGNITIVE ASSESSMENT ROUTES
// ------------------------------------------------------------------

// GET /profile/:userId/cognitive — get assessment history
router.get('/:userId/cognitive', requireAuth, async (req, res) => {
  try {
    const { userId } = req.params;

    if (req.user.role !== 'ADMIN' && req.user.sub !== userId) {
      return res.status(403).json({ detail: 'Access denied' });
    }

    const assessments = await prisma.cognitive_assessments.findMany({
      where: { user_id: userId },
      orderBy: { taken_at: 'desc' },
    });

    res.json({ assessments });
  } catch (err) {
    res.status(500).json({ detail: err.message });
  }
});

// GET /profile/:userId/cognitive/latest — get latest valid assessment
router.get('/:userId/cognitive/latest', requireAuth, async (req, res) => {
  try {
    const { userId } = req.params;

    if (req.user.role !== 'ADMIN' && req.user.sub !== userId) {
      return res.status(403).json({ detail: 'Access denied' });
    }

    const latest = await prisma.cognitive_assessments.findFirst({
      where: {
        user_id: userId,
        valid_until: { gte: new Date() },
      },
      orderBy: { taken_at: 'desc' },
    });

    res.json({ assessment: latest || null, has_valid: !!latest });
  } catch (err) {
    res.status(500).json({ detail: err.message });
  }
});

// POST /profile/:userId/cognitive — submit new assessment
router.post('/:userId/cognitive', requireAuth, async (req, res) => {
  try {
    const { userId } = req.params;

    if (req.user.role !== 'ADMIN' && req.user.sub !== userId) {
      return res.status(403).json({ detail: 'Access denied' });
    }

    const {
      score,
      reaction_time_ms,
      memory_score,
      attention_score,
      spatial_score,
      knowledge_score,
      answers,
    } = req.body;

    if (score === undefined || score < 0 || score > 100) {
      return res.status(400).json({ detail: 'Score must be between 0 and 100' });
    }

    const result = getCognitiveResult(score);

    // Valid for 30 days
    const validUntil = new Date();
    validUntil.setDate(validUntil.getDate() + 30);

    const assessment = await prisma.cognitive_assessments.create({
      data: {
        id: crypto.randomUUID(),
        user_id: userId,
        score,
        reaction_time_ms,
        memory_score,
        attention_score,
        spatial_score,
        knowledge_score,
        answers: answers || {},
        result,
        valid_until: validUntil,
      },
    });

    res.status(201).json(assessment);
  } catch (err) {
    res.status(500).json({ detail: err.message });
  }
});

// ------------------------------------------------------------------
// ADMIN — list all workers with profile summary
// ------------------------------------------------------------------

// GET /profile — list all workers (admin only)
router.get('/', requireAdmin, async (req, res) => {
  try {
    const workers = await prisma.users.findMany({
      where: { role: 'WORKER', is_active: true },
      include: {
        worker_profiles: true,
        cognitive_assessments: {
          orderBy: { taken_at: 'desc' },
          take: 1,
        },
      },
      orderBy: { created_at: 'desc' },
    });

    res.json({
      workers: workers.map(w => ({
        id: w.id,
        email: w.email,
        full_name: w.full_name,
        employee_id: w.employee_id,
        profile_picture: w.profile_picture,
        profile: w.worker_profiles || null,
        latest_cognitive: w.cognitive_assessments[0] || null,
      })),
    });
  } catch (err) {
    res.status(500).json({ detail: err.message });
  }
});

export default router;
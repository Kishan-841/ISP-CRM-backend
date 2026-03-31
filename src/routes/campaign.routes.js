import express from 'express';
import { auth, requireRole } from '../middleware/auth.js';
import {
  getCampaigns,
  getCampaign,
  createCampaign,
  updateCampaign,
  deleteCampaign,
  assignUsersToCampaign,
  getMyAssignedCampaigns,
  addCampaignData,
  addSingleCampaignData,
  getCampaignData,
  startCall,
  endCall,
  getCallHistory,
  updateDataStatus,
  addRemark,
  getCampaignDataDetail,
  getISRDashboardStats,
  createSelfCampaign,
  deleteSelfCampaign,
  deleteCampaignData,
  getFollowUps,
  getFollowUpCount,
  markFollowUpComplete,
  getUnansweredCalls,
  getUnansweredCallsCount,
  getAllCallHistory,
  getReportsData,
  getDataBatches,
  getCallDispositionData,
  getLeaderboardData,
  getDataSourceROI,
  getWeeklyTrends,
  getMyCampaignPerformance,
  getAllCampaignData,
  getISRPipelineFunnel,
  getISRPipelineComparison,
  exportCampaignData,
  editCampaignData
} from '../controllers/campaign.controller.js';

const router = express.Router();

// All routes require authentication
router.use(auth);

// Admin + BDM + BDM_TEAM_LEADER campaign routes
router.get('/', requireRole('SUPER_ADMIN', 'SALES_DIRECTOR', 'BDM', 'BDM_TEAM_LEADER'), getCampaigns);
router.post('/', requireRole('SUPER_ADMIN', 'BDM', 'BDM_TEAM_LEADER'), createCampaign);
router.put('/:id', requireRole('SUPER_ADMIN'), updateCampaign);
router.delete('/:id', requireRole('SUPER_ADMIN'), deleteCampaign);
router.post('/:id/assign', requireRole('SUPER_ADMIN', 'BDM', 'BDM_TEAM_LEADER'), assignUsersToCampaign);
router.post('/:id/data', requireRole('SUPER_ADMIN', 'BDM', 'BDM_TEAM_LEADER'), addCampaignData);

// All data route (must be before /:id routes)
router.get('/all-data', getAllCampaignData);

// ISR routes
router.get('/my-campaigns', getMyAssignedCampaigns);
router.get('/dashboard/stats', getISRDashboardStats);
router.post('/self-campaign', createSelfCampaign);
router.delete('/self-campaign/:id', deleteSelfCampaign);
router.delete('/data/:dataId', deleteCampaignData);

// Follow-ups routes
router.get('/follow-ups', getFollowUps);
router.get('/follow-ups/count', getFollowUpCount);
router.post('/follow-ups/:dataId/complete', markFollowUpComplete);

// Unanswered calls (Retry Queue) routes
router.get('/unanswered-calls', getUnansweredCalls);
router.get('/unanswered-calls/count', getUnansweredCallsCount);

// Call history route (all calls)
router.get('/call-history', getAllCallHistory);

// Reports routes
router.get('/reports', getReportsData);
router.get('/reports/leaderboard', getLeaderboardData);
router.get('/reports/disposition', getCallDispositionData);
router.get('/reports/data-batches', getDataBatches);
router.get('/reports/data-source-roi', getDataSourceROI);
router.get('/reports/weekly-trends', getWeeklyTrends);
router.get('/reports/my-performance', getMyCampaignPerformance);
router.get('/reports/export-campaign-data', exportCampaignData);

// ISR Pipeline Funnel routes
router.get('/reports/pipeline-funnel', requireRole('SUPER_ADMIN', 'SALES_DIRECTOR', 'ISR', 'BDM_TEAM_LEADER'), getISRPipelineFunnel);
router.get('/reports/pipeline-comparison', requireRole('SUPER_ADMIN', 'SALES_DIRECTOR', 'BDM_TEAM_LEADER'), getISRPipelineComparison);

// Shared routes (both Admin and assigned ISR)
router.get('/:id', getCampaign);
router.get('/:id/data', getCampaignData);
router.post('/:id/data/single', addSingleCampaignData);

// Call management
router.post('/call/start/:dataId', startCall);
router.post('/call/end/:callLogId', endCall);
router.get('/call/history/:dataId', getCallHistory);

// Data management (ISR)
router.get('/data/:dataId', getCampaignDataDetail);
router.put('/data/:dataId/status', updateDataStatus);
router.put('/data/:dataId/remark', addRemark);
router.put('/data/:dataId/edit', editCampaignData);

export default router;

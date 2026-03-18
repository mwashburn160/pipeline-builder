import { sendSuccess, sendBadRequest, ErrorCode, validateBody } from '@mwashburn160/api-core';
import { withRoute } from '@mwashburn160/api-server';
import { Router } from 'express';
import { z } from 'zod';
import { RULE_TEMPLATES } from '../data/rule-templates';
import { complianceRuleService } from '../services/compliance-rule-service';

/**
 * Feature #9: Rule templates — starter rules that orgs can adopt.
 */

const ApplyTemplatesSchema = z.object({
  templateIds: z.array(z.string()).min(1).max(50),
});

export function createTemplateRoutes(): Router {
  const router = Router();

  // GET / — list available rule templates
  router.get('/', withRoute(async ({ res, ctx }) => {
    ctx.log('COMPLETED', 'Listed rule templates', { count: RULE_TEMPLATES.length });
    return sendSuccess(res, 200, { templates: RULE_TEMPLATES });
  }));

  // POST /apply — create org rules from selected templates
  router.post('/apply', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const validation = validateBody(req, ApplyTemplatesSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }

    const selectedIds = new Set(validation.value.templateIds);
    const templates = RULE_TEMPLATES.filter(t => selectedIds.has(t.id));

    const created: string[] = [];
    const skipped: string[] = [];

    for (const template of templates) {
      try {
        const rule = await complianceRuleService.create({
          orgId,
          name: template.name,
          description: template.description,
          target: template.target,
          severity: template.severity,
          field: template.field,
          operator: template.operator,
          value: template.value,
          priority: template.priority,
          tags: template.tags,
          scope: 'org',
          createdBy: userId,
          updatedBy: userId,
        } as unknown as Parameters<typeof complianceRuleService.create>[0], userId);
        created.push(rule.id);
      } catch {
        skipped.push(template.id);
      }
    }

    ctx.log('COMPLETED', 'Applied rule templates', { created: created.length, skipped: skipped.length });
    return sendSuccess(res, 201, { created: created.length, skipped: skipped.length, ruleIds: created });
  }));

  return router;
}

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import { SamplingPlanInput } from '@wansurvey/schema/sampling';
import { z } from 'zod';
import { Auth, RequirePermission, type AuthContext } from '../common/auth-context.js';
import { ZodPipe } from '../common/zod.js';
import {
  BatchBody,
  FieldCasesBody,
  ReleaseBody,
  SamplingService,
  SubstituteBody,
} from './sampling.service.js';

const PERM = { projectParam: 'projectId' } as const;

/** Each questionnaire has its own plan and frame; without one, the project's first. */
const QuestionnaireQuery = z.object({ questionnaireId: z.uuid().optional() });
type QQ = z.infer<typeof QuestionnaireQuery>;
const QPipe = new ZodPipe(QuestionnaireQuery);

/** The sampling selector of a project (S1): plan, preview, selection, reserves, substitutes. */
@ApiTags('sampling')
@Controller('projects/:projectId/sampling')
export class SamplingController {
  constructor(private readonly sampling: SamplingService) {}

  @Get()
  @RequirePermission('cases.read_all', PERM)
  get(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query(QPipe) q: QQ,
  ) {
    return this.sampling.get(ctx.tenantId, projectId, q.questionnaireId);
  }

  @Put()
  @RequirePermission('cases.import', PERM)
  @ApiBody({ schema: z.toJSONSchema(SamplingPlanInput, { io: 'input' }) as object })
  save(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body(new ZodPipe(SamplingPlanInput)) body: SamplingPlanInput,
    @Query(QPipe) q: QQ,
  ) {
    return this.sampling.save(ctx, projectId, body, q.questionnaireId);
  }

  @Post('preview')
  @HttpCode(200)
  @RequirePermission('cases.import', PERM)
  preview(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query(QPipe) q: QQ,
  ) {
    return this.sampling.preview(ctx.tenantId, projectId, q.questionnaireId);
  }

  @Post('select')
  @HttpCode(200)
  @RequirePermission('cases.import', PERM)
  select(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query(QPipe) q: QQ,
  ) {
    return this.sampling.select(ctx, projectId, q.questionnaireId);
  }

  @Post('release')
  @HttpCode(200)
  @RequirePermission('cases.import', PERM)
  @ApiBody({ schema: z.toJSONSchema(ReleaseBody) as object })
  release(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body(new ZodPipe(ReleaseBody)) body: z.infer<typeof ReleaseBody>,
    @Query(QPipe) q: QQ,
  ) {
    return this.sampling.release(ctx, projectId, body, q.questionnaireId);
  }

  @Post('batch')
  @HttpCode(200)
  @RequirePermission('cases.import', PERM)
  @ApiBody({ schema: z.toJSONSchema(BatchBody) as object })
  batch(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body(new ZodPipe(BatchBody)) body: z.infer<typeof BatchBody>,
    @Query(QPipe) q: QQ,
  ) {
    return this.sampling.batch(ctx, projectId, body, q.questionnaireId);
  }

  @Post('cases/:caseId/substitute')
  @HttpCode(200)
  @RequirePermission('cases.import', PERM)
  @ApiBody({ schema: z.toJSONSchema(SubstituteBody) as object })
  substitute(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('caseId', ParseUUIDPipe) caseId: string,
    @Body(new ZodPipe(SubstituteBody)) body: z.infer<typeof SubstituteBody>,
  ) {
    return this.sampling.substitute(ctx, projectId, caseId, body.reason);
  }

  @Post('field-cases')
  @HttpCode(200)
  @RequirePermission('cases.import', PERM)
  @ApiBody({ schema: z.toJSONSchema(FieldCasesBody) as object })
  fieldCases(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body(new ZodPipe(FieldCasesBody)) body: z.infer<typeof FieldCasesBody>,
    @Query(QPipe) q: QQ,
  ) {
    return this.sampling.fieldCases(ctx, projectId, body, q.questionnaireId);
  }

  @Delete('frame')
  @RequirePermission('cases.import', PERM)
  clearFrame(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query(QPipe) q: QQ,
  ) {
    return this.sampling.clearFrame(ctx, projectId, q.questionnaireId);
  }
}

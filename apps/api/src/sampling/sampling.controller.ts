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
} from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import { SamplingPlanInput } from '@wansurvey/schema/sampling';
import { z } from 'zod';
import { Auth, RequirePermission, type AuthContext } from '../common/auth-context.js';
import { ZodPipe } from '../common/zod.js';
import {
  FieldCasesBody,
  ReleaseBody,
  SamplingService,
  SubstituteBody,
} from './sampling.service.js';

const PERM = { projectParam: 'projectId' } as const;

/** The sampling selector of a project (S1): plan, preview, selection, reserves, substitutes. */
@ApiTags('sampling')
@Controller('projects/:projectId/sampling')
export class SamplingController {
  constructor(private readonly sampling: SamplingService) {}

  @Get()
  @RequirePermission('cases.read_all', PERM)
  get(@Auth() ctx: AuthContext, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.sampling.get(ctx.tenantId, projectId);
  }

  @Put()
  @RequirePermission('cases.import', PERM)
  @ApiBody({ schema: z.toJSONSchema(SamplingPlanInput, { io: 'input' }) as object })
  save(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body(new ZodPipe(SamplingPlanInput)) body: SamplingPlanInput,
  ) {
    return this.sampling.save(ctx, projectId, body);
  }

  @Post('preview')
  @HttpCode(200)
  @RequirePermission('cases.import', PERM)
  preview(@Auth() ctx: AuthContext, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.sampling.preview(ctx.tenantId, projectId);
  }

  @Post('select')
  @HttpCode(200)
  @RequirePermission('cases.import', PERM)
  select(@Auth() ctx: AuthContext, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.sampling.select(ctx, projectId);
  }

  @Post('release')
  @HttpCode(200)
  @RequirePermission('cases.import', PERM)
  @ApiBody({ schema: z.toJSONSchema(ReleaseBody) as object })
  release(
    @Auth() ctx: AuthContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body(new ZodPipe(ReleaseBody)) body: z.infer<typeof ReleaseBody>,
  ) {
    return this.sampling.release(ctx, projectId, body);
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
  ) {
    return this.sampling.fieldCases(ctx, projectId, body);
  }

  @Delete('frame')
  @RequirePermission('cases.import', PERM)
  clearFrame(@Auth() ctx: AuthContext, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.sampling.clearFrame(ctx, projectId);
  }
}

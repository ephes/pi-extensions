lint:
    npm run lint

typecheck:
    npm run typecheck

test:
    npm run test

check:
    npm run check

loc:
    @git ls-files -z '*.ts' | xargs -0 wc -l | tail -n 1 | awk '{print $1 " lines of TypeScript"}'

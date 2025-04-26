'use client';
import { ClientMetricReportDirection } from "amazon-chime-sdk-js";
import { RubricCheckSelectOption, RubricCriteriaSelectGroupOption, RubricCheckSubOptions } from "./code-file";
import { Menu, MenuItem, SubMenu } from "@jonbell/react-radial-menu";
import { Box } from "@chakra-ui/react";


function RubricCheckSubMenuOrItem({ criterion, option, handleItemClick, handleSubItemClick, handleDisplayClick }: { criterion: RubricCriteriaSelectGroupOption, option: RubricCheckSelectOption, handleItemClick: (event: React.MouseEvent<SVGGElement, MouseEvent>, index: number, data?: RubricCheckSelectOption) => void, handleSubItemClick: (event: React.MouseEvent<SVGGElement, MouseEvent>, index: number, data?: RubricCheckSubOptions) => void, handleDisplayClick: (event: React.MouseEvent<SVGGElement, MouseEvent>, position: string) => void }) {
    if (option.options?.length) {
        return <SubMenu key={option.value}
            onItemClick={handleItemClick} onDisplayClick={handleDisplayClick} itemView={option.label} data={option} displayPosition="bottom">
            {option.options.map((subOption) => (
                <MenuItem key={subOption.index} onItemClick={handleSubItemClick} data={subOption}>
                    {subOption.label}
                </MenuItem>
            ))}
        </SubMenu>
    }
    return <MenuItem key={option.value} onItemClick={handleItemClick} data={option}>
        {option.label}
    </MenuItem>
}
function RubricCriteriaSubMenuOrItem({ criterion, handleItemClick, handleSubItemClick, handleDisplayClick }: { criterion: RubricCriteriaSelectGroupOption, handleItemClick: (event: React.MouseEvent<SVGGElement, MouseEvent>, index: number, data?: RubricCheckSelectOption) => void, handleSubItemClick: (event: React.MouseEvent<SVGGElement, MouseEvent>, index: number, data?: RubricCheckSubOptions) => void, handleDisplayClick: (event: React.MouseEvent<SVGGElement, MouseEvent>, position: string) => void }) {
    if (criterion.options.length > 1) {
        const children = criterion.options.map((option) => RubricCheckSubMenuOrItem({
            criterion,
            option,
            handleItemClick,
            handleSubItemClick,
            handleDisplayClick
        }));
        return <SubMenu key={criterion.value}
            onItemClick={handleItemClick} onDisplayClick={handleDisplayClick} itemView={criterion.label} data={criterion} displayPosition="bottom">
            {children}
        </SubMenu>
    }
    else if (criterion.options.length === 1) {
        return RubricCheckSubMenuOrItem({
            criterion,
            option: criterion.options[0],
            handleItemClick,
            handleSubItemClick,
            handleDisplayClick
        });
    }
    else {
        throw new Error("RubricCriteriaSubMenuOrItem: Expected at least 1 option, got " + criterion.options.length);
    }
}
export function RubricMarkingMenu({ criteria, top, left, setSelectedCheckOption, setSelectedSubOption, setCurrentMode }: { criteria: RubricCriteriaSelectGroupOption[], top: number, left: number, setSelectedCheckOption: (option: RubricCheckSelectOption | null) => void, setSelectedSubOption: (option: RubricCheckSubOptions | null) => void, setCurrentMode: (mode: "marking" | "select") => void }) {
    // You can also use separate handler for each item
    const handleItemClick = (event: React.MouseEvent<SVGGElement, MouseEvent>, index: number, data?: RubricCheckSelectOption) => {
        setSelectedCheckOption(data!);
        setSelectedSubOption(null);
        setCurrentMode("select");
    };
    const handleSubItemClick = (event: React.MouseEvent<SVGGElement, MouseEvent>, index: number, data?: RubricCheckSubOptions) => {
        //This is not very nice, but it works...
        setSelectedCheckOption(data!.check!);
        setSelectedSubOption(data!);
        setCurrentMode("select");
    };
    const handleSubMenuClick = (event: React.MouseEvent<SVGGElement, MouseEvent>, index: number, data?: string) => {
        console.log(`[SubMenu] ${data} clicked`);
    };
    const handleDisplayClick = (event: React.MouseEvent<SVGGElement, MouseEvent>, position: string) => {
        console.log(`[Display] ${position} clicked`);
    };

    const children = criteria.map((criterion) => RubricCriteriaSubMenuOrItem({
        criterion,
        handleItemClick,
        handleSubItemClick,
        handleDisplayClick
    }));
    return <Box css={{
        '--__reactRadialMenu__menu-bgColor': 'var(--chakra-colors-bg-inverted)',
        '--__reactRadialMenu__item-color': 'var(--chakra-colors-fg-inverted)',
        '--__reactRadialMenu__separator-color': 'var(--chakra-colors-border-emphasized)',
        '--__reactRadialMenu__activeItem-color': 'var(--chakra-colors-fg-emphasized)',
        '--__reactRadialMenu__activeItem-bgColor': 'var(--chakra-colors-bg-emphasized)',
        '--__reactRadialMenu__arrow-color': 'var(--chakra-colors-fg-inverted)',
        '__reactRadialMenu__activeArrowColor': 'var(--chakra-colors-fg-emphasized)',

        '& .__rrm-content':{
            padding: '5px'
        }
    }}><Menu
        centerX={left}
        centerY={top}
        innerRadius={75}
        outerRadius={100}
        show={true}
        hoverToOpen={true}
        hoverToBackTimeout={300}
        animation={["fade", "scale"]}
        animationTimeout={150}
        drawBackground>
            {children}
        </Menu>
    </Box>
}